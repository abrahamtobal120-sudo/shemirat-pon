package dev.shomer.android;

import java.util.ArrayList;
import java.util.List;

/**
 * Keeps the screen covers stable despite the capture loop.
 *
 * Shomer captures the screen and draws covers on top of it, so the next captured frame shows the
 * cover instead of the person underneath: the detector can no longer see what it is hiding. Covers
 * therefore stay put until the rest of the screen changes noticeably (scroll, new app, new photo),
 * judged by a coarse luminance grid that ignores the cells under covers. Pure Java for unit tests.
 *
 * All coordinates are normalised to the captured frame (0..1).
 */
final class CoverTracker {
    static final int GRID_W = 24;
    static final int GRID_H = 48;
    /** A cell counts as changed when its mean luminance moved more than this (0..255). */
    static final float CELL_DELTA = 14f;
    /** Fraction of visible cells that must change to treat it as a new screen and drop covers. */
    static final float SCENE_CHANGE = 0.22f;
    static final int MAX_COVERS = 24;

    private final List<YoloDecoder.Box> covers = new ArrayList<>();
    private float[] reference;

    List<YoloDecoder.Box> covers() {
        List<YoloDecoder.Box> copy = new ArrayList<>(covers.size());
        for (YoloDecoder.Box b : covers) copy.add(b.copy());
        return copy;
    }

    boolean isEmpty() { return covers.isEmpty(); }

    void clear() {
        covers.clear();
        reference = null;
    }

    /**
     * True if the visible part of {@code grid} (GRID_W x GRID_H luminance) differs enough from the
     * reference taken when the covers were placed. Cells under a cover are ignored.
     */
    boolean sceneChanged(float[] grid) {
        if (reference == null || covers.isEmpty() || grid == null || grid.length != reference.length) return false;
        int visible = 0, changed = 0;
        for (int gy = 0; gy < GRID_H; gy++) {
            for (int gx = 0; gx < GRID_W; gx++) {
                if (underCover(gx, gy)) continue;
                visible++;
                int i = gy * GRID_W + gx;
                if (Math.abs(grid[i] - reference[i]) > CELL_DELTA) changed++;
            }
        }
        // Covers hide almost everything: nothing left to compare, so keep them (fail safe).
        if (visible < GRID_W * GRID_H / 10) return false;
        return changed > visible * SCENE_CHANGE;
    }

    /**
     * Processes one analysed frame.
     *
     * @param grid       luminance grid of the frame (may be null)
     * @param detections boxes that must be covered, normalised, already padded
     * @return true if the set of covers changed (the overlay must be redrawn)
     */
    boolean update(float[] grid, List<YoloDecoder.Box> detections) {
        boolean dirty = false;
        if (sceneChanged(grid)) {
            covers.clear();
            dirty = true;
        }
        for (YoloDecoder.Box detection : detections) {
            YoloDecoder.Box d = detection.copy();
            clampUnit(d);
            if (d.area() <= 0) continue;
            if (contained(d)) continue;
            // Merge with every cover it touches (a person larger than the old cover keeps growing it).
            for (int i = covers.size() - 1; i >= 0; i--) {
                if (covers.get(i).intersects(d)) d.union(covers.remove(i));
            }
            covers.add(d);
            dirty = true;
        }
        while (covers.size() > MAX_COVERS) {
            // Too many separate covers: fold the smallest into its neighbour list as one big box.
            YoloDecoder.Box a = covers.remove(covers.size() - 1);
            covers.get(covers.size() - 1).union(a);
        }
        if (dirty || covers.isEmpty() || reference == null) reference = grid == null ? null : grid.clone();
        return dirty;
    }

    private boolean contained(YoloDecoder.Box d) {
        for (YoloDecoder.Box c : covers) {
            if (d.x1 >= c.x1 && d.y1 >= c.y1 && d.x2 <= c.x2 && d.y2 <= c.y2) return true;
        }
        return false;
    }

    private boolean underCover(int gx, int gy) {
        float cx1 = gx / (float) GRID_W, cx2 = (gx + 1) / (float) GRID_W;
        float cy1 = gy / (float) GRID_H, cy2 = (gy + 1) / (float) GRID_H;
        for (YoloDecoder.Box c : covers) {
            if (cx1 < c.x2 && c.x1 < cx2 && cy1 < c.y2 && c.y1 < cy2) return true;
        }
        return false;
    }

    /** Grows a box by {@code fraction} of its size on each side (covers a little more than the person). */
    static YoloDecoder.Box pad(YoloDecoder.Box b, float fraction) {
        float dx = b.width() * fraction, dy = b.height() * fraction;
        return new YoloDecoder.Box(b.x1 - dx, b.y1 - dy, b.x2 + dx, b.y2 + dy, b.score);
    }

    private static void clampUnit(YoloDecoder.Box b) {
        b.x1 = YoloDecoder.clamp(b.x1, 0, 1); b.y1 = YoloDecoder.clamp(b.y1, 0, 1);
        b.x2 = YoloDecoder.clamp(b.x2, 0, 1); b.y2 = YoloDecoder.clamp(b.y2, 0, 1);
    }
}
