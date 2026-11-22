package dev.shomer.android;

import android.content.Context;
import android.graphics.Bitmap;
import android.graphics.Canvas;
import android.graphics.Color;
import android.graphics.Paint;
import android.graphics.Rect;
import android.graphics.RectF;

import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.FloatBuffer;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.Map;

import ai.onnxruntime.NodeInfo;
import ai.onnxruntime.OnnxTensor;
import ai.onnxruntime.OnnxValue;
import ai.onnxruntime.OrtEnvironment;
import ai.onnxruntime.OrtException;
import ai.onnxruntime.OrtSession;
import ai.onnxruntime.TensorInfo;

/**
 * On-device person detection + gender classification for screen frames, with the same models and
 * defaults as Shomer Web (shomer-web/models). Nothing leaves the phone. Not thread-safe: call from
 * one worker thread.
 */
final class ScreenDetector implements AutoCloseable {
    /** Same defaults as shomer-web/common/settings.js. */
    static final float PERSON_CONF = 0.25f;
    static final float FEMALE_THRESHOLD = 0.35f; // doubt → covered
    static final float MIN_PERSON_FRAC = 0.05f;  // of the frame height (thumbnails in feeds count)
    static final int MAX_CLASSIFIED = 8;         // more people than this are covered without asking

    private static final int DEFAULT_YOLO_SIZE = 384;
    private static final int DEFAULT_GENDER_W = 128, DEFAULT_GENDER_H = 256;
    private static final float GENDER_PAD = 0.08f;
    private static final int FEMALE_INDEX = 1;

    private final OrtEnvironment env;
    private final OrtSession yolo;
    private final String yoloInput;
    private final int yoloSize;
    private final OrtSession gender; // null → every person is covered (fail safe)
    private final String genderInput;
    private final int genderW, genderH;

    private final Bitmap letterbox;
    private final Canvas letterboxCanvas;
    private final int[] letterboxPixels;
    private final float[] yoloData;
    private final Bitmap crop;
    private final Canvas cropCanvas;
    private final int[] cropPixels;
    private final float[] genderData;
    private final Paint filter = new Paint(Paint.FILTER_BITMAP_FLAG);

    private ScreenDetector(OrtEnvironment env, OrtSession yolo, OrtSession gender) throws OrtException {
        this.env = env;
        this.yolo = yolo;
        this.yoloInput = yolo.getInputNames().iterator().next();
        long[] yShape = inputShape(yolo);
        this.yoloSize = yShape.length == 4 && yShape[2] > 0 ? (int) yShape[2] : DEFAULT_YOLO_SIZE;
        this.gender = gender;
        if (gender != null) {
            this.genderInput = gender.getInputNames().iterator().next();
            long[] gShape = inputShape(gender);
            this.genderH = gShape.length == 4 && gShape[2] > 0 ? (int) gShape[2] : DEFAULT_GENDER_H;
            this.genderW = gShape.length == 4 && gShape[3] > 0 ? (int) gShape[3] : DEFAULT_GENDER_W;
        } else {
            this.genderInput = null;
            this.genderH = DEFAULT_GENDER_H;
            this.genderW = DEFAULT_GENDER_W;
        }
        letterbox = Bitmap.createBitmap(yoloSize, yoloSize, Bitmap.Config.ARGB_8888);
        letterboxCanvas = new Canvas(letterbox);
        letterboxPixels = new int[yoloSize * yoloSize];
        yoloData = new float[3 * yoloSize * yoloSize];
        crop = Bitmap.createBitmap(genderW, genderH, Bitmap.Config.ARGB_8888);
        cropCanvas = new Canvas(crop);
        cropPixels = new int[genderW * genderH];
        genderData = new float[3 * genderW * genderH];
    }

    /** Loads the models from the APK assets. Throws if the person detector cannot be loaded. */
    static ScreenDetector load(Context context) throws IOException, OrtException {
        OrtEnvironment env = OrtEnvironment.getEnvironment();
        OrtSession.SessionOptions options = new OrtSession.SessionOptions();
        options.setOptimizationLevel(OrtSession.SessionOptions.OptLevel.ALL_OPT);
        options.setIntraOpNumThreads(Math.max(1, Math.min(4, Runtime.getRuntime().availableProcessors() / 2)));
        OrtSession yolo = env.createSession(extract(context, "yolov8n-seg.onnx").getAbsolutePath(), options);
        OrtSession gender = null;
        try {
            gender = env.createSession(extract(context, "gender.onnx").getAbsolutePath(), options);
        } catch (IOException | OrtException missing) {
            // Without the gender model every person is covered.
        }
        return new ScreenDetector(env, yolo, gender);
    }

    boolean hasGenderModel() { return gender != null; }

    /**
     * Returns the regions of {@code frame} to cover, normalised to 0..1 and already padded.
     */
    List<YoloDecoder.Box> analyze(Bitmap frame) throws OrtException {
        int fw = frame.getWidth(), fh = frame.getHeight();
        List<YoloDecoder.Box> people = new ArrayList<>();
        for (int[] tile : YoloDecoder.tiles(fw, fh)) people.addAll(detectTile(frame, tile, fw, fh));
        people = YoloDecoder.nms(people, YoloDecoder.NMS_IOU, YoloDecoder.MAX_PERSONS);

        List<YoloDecoder.Box> result = new ArrayList<>();
        int classified = 0;
        for (YoloDecoder.Box p : people) {
            if (p.height() / fh < MIN_PERSON_FRAC) continue;
            boolean cover = true;
            if (gender != null && classified < MAX_CLASSIFIED) {
                classified++;
                cover = femaleProbability(frame, p) >= FEMALE_THRESHOLD;
            }
            if (!cover) continue;
            YoloDecoder.Box n = new YoloDecoder.Box(p.x1 / fw, p.y1 / fh, p.x2 / fw, p.y2 / fh, p.score);
            result.add(CoverTracker.pad(n, 0.06f));
        }
        return result;
    }

    private List<YoloDecoder.Box> detectTile(Bitmap frame, int[] tile, int fw, int fh) throws OrtException {
        int S = yoloSize;
        YoloDecoder.Letterbox lb = new YoloDecoder.Letterbox(S, tile[2], tile[3]);
        letterboxCanvas.drawColor(Color.rgb(114, 114, 114));
        Rect src = new Rect(tile[0], tile[1], tile[0] + tile[2], tile[1] + tile[3]);
        RectF dst = new RectF(lb.padX, lb.padY, lb.padX + Math.round(tile[2] * lb.scale), lb.padY + Math.round(tile[3] * lb.scale));
        letterboxCanvas.drawBitmap(frame, src, dst, filter);
        letterbox.getPixels(letterboxPixels, 0, S, 0, 0, S, S);
        toChw(letterboxPixels, yoloData, S * S);

        try (OnnxTensor input = OnnxTensor.createTensor(env, FloatBuffer.wrap(yoloData), new long[]{1, 3, S, S});
             OrtSession.Result out = yolo.run(Collections.singletonMap(yoloInput, input))) {
            for (Map.Entry<String, OnnxValue> entry : out) {
                if (!(entry.getValue() instanceof OnnxTensor)) continue;
                OnnxTensor tensor = (OnnxTensor) entry.getValue();
                long[] shape = tensor.getInfo().getShape();
                if (shape.length != 3) continue; // skip the mask prototypes (4-D)
                int channels = (int) shape[1], count = (int) shape[2];
                FloatBuffer buffer = tensor.getFloatBuffer();
                float[] pred = new float[buffer.remaining()];
                buffer.get(pred);
                List<YoloDecoder.Box> mapped = new ArrayList<>();
                for (YoloDecoder.Box b : YoloDecoder.decode(pred, channels, count, PERSON_CONF)) {
                    YoloDecoder.Box m = lb.toSource(b, tile[0], tile[1], fw, fh);
                    if (m.area() > 0) mapped.add(m);
                }
                return mapped;
            }
        }
        throw new IllegalStateException("El modelo YOLO no devolvió detecciones");
    }

    private float femaleProbability(Bitmap frame, YoloDecoder.Box b) {
        try {
            int W = genderW, H = genderH;
            float bw = b.width(), bh = b.height();
            float sx = b.x1 - bw * GENDER_PAD, sy = b.y1 - bh * GENDER_PAD;
            float sw = bw * (1 + 2 * GENDER_PAD), sh = bh * (1 + 2 * GENDER_PAD);
            // Crop with black outside the frame (like the web engine), mapping only the visible part.
            float vx1 = Math.max(0, sx), vy1 = Math.max(0, sy);
            float vx2 = Math.min(frame.getWidth(), sx + sw), vy2 = Math.min(frame.getHeight(), sy + sh);
            cropCanvas.drawColor(Color.BLACK);
            if (vx2 > vx1 && vy2 > vy1) {
                Rect src = new Rect(Math.round(vx1), Math.round(vy1), Math.round(vx2), Math.round(vy2));
                RectF dst = new RectF((vx1 - sx) / sw * W, (vy1 - sy) / sh * H, (vx2 - sx) / sw * W, (vy2 - sy) / sh * H);
                cropCanvas.drawBitmap(frame, src, dst, filter);
            }
            crop.getPixels(cropPixels, 0, W, 0, 0, W, H);
            toChw(cropPixels, genderData, W * H); // models.json: mean 0, std 1
            try (OnnxTensor input = OnnxTensor.createTensor(env, FloatBuffer.wrap(genderData), new long[]{1, 3, H, W});
                 OrtSession.Result out = gender.run(Collections.singletonMap(genderInput, input))) {
                OnnxTensor tensor = (OnnxTensor) out.get(0);
                FloatBuffer buffer = tensor.getFloatBuffer();
                float[] values = new float[buffer.remaining()];
                buffer.get(values);
                return femaleFromOutput(values);
            }
        } catch (OrtException | RuntimeException failure) {
            return 1f; // in doubt, cover
        }
    }

    /** Softmax (index 1 = female) or a single sigmoid/probability, as in shomer-web/engine/gender.js. */
    static float femaleFromOutput(float[] values) {
        if (values.length == 0) return 1f;
        if (values.length == 1) {
            float v = values[0];
            return v >= 0 && v <= 1 ? v : (float) (1 / (1 + Math.exp(-v)));
        }
        float max = Float.NEGATIVE_INFINITY;
        for (float v : values) max = Math.max(max, v);
        double sum = 0, female = 0;
        for (int i = 0; i < values.length; i++) {
            double e = Math.exp(values[i] - max);
            sum += e;
            if (i == FEMALE_INDEX) female = e;
        }
        float p = (float) (female / sum);
        return Float.isNaN(p) ? 1f : p;
    }

    private static void toChw(int[] pixels, float[] out, int plane) {
        for (int p = 0; p < plane; p++) {
            int c = pixels[p];
            out[p] = ((c >> 16) & 0xFF) / 255f;
            out[p + plane] = ((c >> 8) & 0xFF) / 255f;
            out[p + 2 * plane] = (c & 0xFF) / 255f;
        }
    }

    private static long[] inputShape(OrtSession session) throws OrtException {
        NodeInfo info = session.getInputInfo().values().iterator().next();
        return info.getInfo() instanceof TensorInfo ? ((TensorInfo) info.getInfo()).getShape() : new long[0];
    }

    /** Copies an asset to private storage once, so ONNX Runtime can memory-map it from a file. */
    private static File extract(Context context, String name) throws IOException {
        File dir = new File(context.getNoBackupFilesDir(), "models");
        if (!dir.isDirectory() && !dir.mkdirs()) throw new IOException("No se pudo crear " + dir);
        File target = new File(dir, name);
        long expected;
        try (android.content.res.AssetFileDescriptor fd = context.getAssets().openFd(name)) {
            expected = fd.getLength();
        } catch (IOException compressed) {
            expected = -1;
        }
        if (target.isFile() && (expected < 0 ? target.length() > 0 : target.length() == expected)) return target;
        File partial = new File(dir, name + ".part");
        try (InputStream in = context.getAssets().open(name); OutputStream out = new FileOutputStream(partial)) {
            byte[] buffer = new byte[1 << 16];
            int read;
            while ((read = in.read(buffer)) > 0) out.write(buffer, 0, read);
        }
        if (!partial.renameTo(target)) {
            target.delete();
            if (!partial.renameTo(target)) throw new IOException("No se pudo guardar " + name);
        }
        return target;
    }

    @Override public void close() {
        try { yolo.close(); } catch (OrtException ignored) { }
        if (gender != null) {
            try { gender.close(); } catch (OrtException ignored) { }
        }
        letterbox.recycle();
        crop.recycle();
    }
}
