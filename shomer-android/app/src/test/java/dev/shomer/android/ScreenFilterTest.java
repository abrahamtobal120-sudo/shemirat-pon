package dev.shomer.android;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import java.util.Arrays;
import java.util.Collections;
import java.util.List;
import org.junit.Test;

public class ScreenFilterTest {
    /** Builds a [1, 4 + 80 + 32, N] channel-major YOLO-seg output with the given boxes. */
    private static float[] prediction(int count, float[][] boxes) {
        int channels = 4 + 80 + 32;
        float[] pred = new float[channels * count];
        for (int i = 0; i < boxes.length; i++) {
            float[] b = boxes[i]; // cx, cy, w, h, personScore
            pred[i] = b[0];
            pred[count + i] = b[1];
            pred[2 * count + i] = b[2];
            pred[3 * count + i] = b[3];
            pred[4 * count + i] = b[4];
        }
        return pred;
    }

    @Test public void decodesPeopleAboveThresholdAndSuppressesDuplicates() {
        float[] pred = prediction(5, new float[][]{
            {100, 100, 40, 80, 0.9f},
            {102, 101, 40, 80, 0.8f},   // duplicate of the first
            {300, 200, 50, 100, 0.6f},
            {50, 50, 10, 10, 0.1f},     // below threshold
        });
        List<YoloDecoder.Box> boxes = YoloDecoder.decode(pred, 116, 5, 0.25f);
        assertEquals(2, boxes.size());
        assertEquals(0.9f, boxes.get(0).score, 1e-6);
        assertEquals(80, boxes.get(0).x1, 1e-4);
        assertEquals(60, boxes.get(0).y1, 1e-4);
        assertEquals(0.6f, boxes.get(1).score, 1e-6);
    }

    @Test public void rejectsMalformedOutput() {
        assertTrue(YoloDecoder.decode(new float[3], 116, 5, 0.25f).isEmpty());
        assertTrue(YoloDecoder.decode(null, 116, 5, 0.25f).isEmpty());
    }

    @Test public void letterboxMapsBackToTile() {
        // A 400x800 tile in a 384 input: scale 0.48, 192x384 centred → padX 96.
        YoloDecoder.Letterbox lb = new YoloDecoder.Letterbox(384, 400, 800);
        assertEquals(0.48f, lb.scale, 1e-6);
        assertEquals(96f, lb.padX, 1e-4);
        assertEquals(0f, lb.padY, 1e-4);
        YoloDecoder.Box mapped = lb.toSource(new YoloDecoder.Box(96, 0, 288, 384, 1), 0, 500, 400, 1300);
        assertEquals(0, mapped.x1, 1e-3);
        assertEquals(500, mapped.y1, 1e-3);
        assertEquals(400, mapped.x2, 1e-3);
        assertEquals(1300, mapped.y2, 1e-3);
    }

    @Test public void tallScreensAreSplitInOverlappingTiles() {
        List<int[]> tiles = YoloDecoder.tiles(432, 960);
        assertEquals(2, tiles.size());
        int[] top = tiles.get(0), bottom = tiles.get(1);
        assertEquals(0, top[1]);
        assertEquals(960, bottom[1] + bottom[3]);
        assertTrue("tiles overlap", top[1] + top[3] > bottom[1]);
        assertEquals(1, YoloDecoder.tiles(800, 900).size());
        List<int[]> wide = YoloDecoder.tiles(960, 432);
        assertEquals(2, wide.size());
        assertEquals(432, wide.get(0)[3]);
    }

    private static float[] grid(float value) {
        float[] g = new float[CoverTracker.GRID_W * CoverTracker.GRID_H];
        Arrays.fill(g, value);
        return g;
    }

    @Test public void coversStayWhileTheScreenIsStill() {
        CoverTracker tracker = new CoverTracker();
        YoloDecoder.Box person = new YoloDecoder.Box(0.2f, 0.2f, 0.4f, 0.5f, 0.9f);
        assertTrue(tracker.update(grid(100), Collections.singletonList(person)));
        // Next frame: the cover now hides the person, so nothing is detected; the rest is unchanged.
        float[] covered = grid(100);
        assertFalse(tracker.update(covered, Collections.emptyList()));
        assertEquals(1, tracker.covers().size());
    }

    @Test public void coversAreDroppedWhenTheScreenChanges() {
        CoverTracker tracker = new CoverTracker();
        tracker.update(grid(100), Collections.singletonList(new YoloDecoder.Box(0.2f, 0.2f, 0.4f, 0.5f, 0.9f)));
        assertTrue(tracker.update(grid(200), Collections.emptyList()));
        assertTrue(tracker.isEmpty());
    }

    @Test public void smallChangesDoNotDropCovers() {
        CoverTracker tracker = new CoverTracker();
        tracker.update(grid(100), Collections.singletonList(new YoloDecoder.Box(0.2f, 0.2f, 0.4f, 0.5f, 0.9f)));
        float[] clock = grid(100);
        for (int i = 0; i < 20; i++) clock[i] = 255; // e.g. the status bar clock
        assertFalse(tracker.update(clock, Collections.emptyList()));
        assertEquals(1, tracker.covers().size());
    }

    @Test public void overlappingDetectionsGrowTheCover() {
        CoverTracker tracker = new CoverTracker();
        tracker.update(grid(100), Collections.singletonList(new YoloDecoder.Box(0.2f, 0.2f, 0.4f, 0.5f, 0.9f)));
        // Part of a bigger person sticks out of the old cover.
        tracker.update(grid(100), Collections.singletonList(new YoloDecoder.Box(0.3f, 0.4f, 0.5f, 0.8f, 0.7f)));
        List<YoloDecoder.Box> covers = tracker.covers();
        assertEquals(1, covers.size());
        assertEquals(0.2f, covers.get(0).x1, 1e-6);
        assertEquals(0.8f, covers.get(0).y2, 1e-6);
    }

    @Test public void detectionsInsideACoverChangeNothing() {
        CoverTracker tracker = new CoverTracker();
        tracker.update(grid(100), Collections.singletonList(new YoloDecoder.Box(0.2f, 0.2f, 0.6f, 0.6f, 0.9f)));
        assertFalse(tracker.update(grid(100), Collections.singletonList(new YoloDecoder.Box(0.3f, 0.3f, 0.4f, 0.4f, 0.5f))));
    }

    @Test public void boxesAreClampedToTheScreen() {
        CoverTracker tracker = new CoverTracker();
        tracker.update(grid(100), Collections.singletonList(CoverTracker.pad(new YoloDecoder.Box(0f, 0.9f, 0.2f, 1f, 1), 0.2f)));
        YoloDecoder.Box c = tracker.covers().get(0);
        assertEquals(0f, c.x1, 0);
        assertEquals(1f, c.y2, 0);
    }
}
