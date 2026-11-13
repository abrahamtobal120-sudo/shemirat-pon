package dev.shomer.android;

import java.util.ArrayList;
import java.util.Collections;
import java.util.List;

/**
 * Decodes the YOLOv8/YOLO11-seg output (same model as shomer-web/engine/yolo-seg.js) into person
 * boxes. Pure Java so it can be unit-tested on the JVM.
 *
 * Output layout: [1, 4 + classes + maskCoefficients, N], channel-major: cx, cy, w, h, class scores...
 * Only class 0 (COCO "person") is used. Mask prototypes are ignored: the phone covers whole boxes.
 */
final class YoloDecoder {
    static final int PERSON = 0;
    static final int MAX_PERSONS = 40;
    static final float NMS_IOU = 0.5f;

    private YoloDecoder() { }

    /** Box in model input pixels (or any coordinate space after mapping). */
    static final class Box {
        float x1, y1, x2, y2, score;

        Box(float x1, float y1, float x2, float y2, float score) {
            this.x1 = x1; this.y1 = y1; this.x2 = x2; this.y2 = y2; this.score = score;
        }

        float width() { return x2 - x1; }
        float height() { return y2 - y1; }
        float area() { return Math.max(0, width()) * Math.max(0, height()); }

        boolean intersects(Box o) { return x1 < o.x2 && o.x1 < x2 && y1 < o.y2 && o.y1 < y2; }

        void union(Box o) {
            x1 = Math.min(x1, o.x1); y1 = Math.min(y1, o.y1);
            x2 = Math.max(x2, o.x2); y2 = Math.max(y2, o.y2);
            score = Math.max(score, o.score);
        }

        Box copy() { return new Box(x1, y1, x2, y2, score); }

        @Override public String toString() {
            return String.format(java.util.Locale.ROOT, "[%.1f,%.1f,%.1f,%.1f %.2f]", x1, y1, x2, y2, score);
        }
    }

    /** Person candidates above {@code conf}, after non-maximum suppression, best first. */
    static List<Box> decode(float[] pred, int channels, int count, float conf) {
        if (pred == null || channels < 5 || count <= 0 || pred.length < channels * count) return Collections.emptyList();
        List<Box> candidates = new ArrayList<>();
        int scoreRow = (4 + PERSON) * count;
        for (int i = 0; i < count; i++) {
            float score = pred[scoreRow + i];
            if (!(score >= conf)) continue; // also rejects NaN
            float cx = pred[i], cy = pred[count + i], w = pred[2 * count + i], h = pred[3 * count + i];
            if (w <= 0 || h <= 0) continue;
            candidates.add(new Box(cx - w / 2, cy - h / 2, cx + w / 2, cy + h / 2, score));
        }
        return nms(candidates, NMS_IOU, MAX_PERSONS);
    }

    static List<Box> nms(List<Box> boxes, float iouThreshold, int max) {
        List<Box> sorted = new ArrayList<>(boxes);
        sorted.sort((a, b) -> Float.compare(b.score, a.score));
        List<Box> kept = new ArrayList<>();
        for (Box candidate : sorted) {
            if (kept.size() >= max) break;
            boolean keep = true;
            for (Box k : kept) {
                if (iou(k, candidate) >= iouThreshold) { keep = false; break; }
            }
            if (keep) kept.add(candidate);
        }
        return kept;
    }

    static float iou(Box a, Box b) {
        float ix = Math.max(0, Math.min(a.x2, b.x2) - Math.max(a.x1, b.x1));
        float iy = Math.max(0, Math.min(a.y2, b.y2) - Math.max(a.y1, b.y1));
        float inter = ix * iy;
        float union = a.area() + b.area() - inter;
        return union > 0 ? inter / union : 0;
    }

    /**
     * Letterbox geometry used to place a {@code srcW x srcH} tile in a {@code size x size} model input
     * (gray padding, centred, like Ultralytics and the web engine).
     */
    static final class Letterbox {
        final int size;
        final float scale, padX, padY;

        Letterbox(int size, int srcW, int srcH) {
            this.size = size;
            this.scale = Math.min(size / (float) srcW, size / (float) srcH);
            this.padX = (size - Math.round(srcW * scale)) / 2f;
            this.padY = (size - Math.round(srcH * scale)) / 2f;
        }

        /** Maps a model-space box back into source coordinates, offset by the tile origin and clamped. */
        Box toSource(Box b, float originX, float originY, float maxX, float maxY) {
            return new Box(
                clamp((b.x1 - padX) / scale + originX, 0, maxX),
                clamp((b.y1 - padY) / scale + originY, 0, maxY),
                clamp((b.x2 - padX) / scale + originX, 0, maxX),
                clamp((b.y2 - padY) / scale + originY, 0, maxY),
                b.score);
        }
    }

    /**
     * Splits a tall (or wide) frame into overlapping tiles closer to square, so people in feeds keep
     * enough pixels after letterboxing. Returns {x, y, w, h} per tile.
     */
    static List<int[]> tiles(int width, int height) {
        List<int[]> tiles = new ArrayList<>();
        boolean tall = height >= width;
        int longSide = tall ? height : width, shortSide = tall ? width : height;
        int count = longSide > shortSide * 1.4f ? 2 : 1;
        if (count == 1) {
            tiles.add(new int[]{0, 0, width, height});
            return tiles;
        }
        int span = Math.round(longSide * 0.56f); // ~12% overlap so nobody is cut in half
        int[] starts = {0, longSide - span};
        for (int start : starts) {
            tiles.add(tall ? new int[]{0, start, width, span} : new int[]{start, 0, span, height});
        }
        return tiles;
    }

    static float clamp(float v, float lo, float hi) { return v < lo ? lo : v > hi ? hi : v; }
}
