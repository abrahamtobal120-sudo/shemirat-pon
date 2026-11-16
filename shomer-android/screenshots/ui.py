"""Tap Android UI elements by visible text through adb + uiautomator (used by capture.sh)."""
import re, subprocess, sys, time, xml.etree.ElementTree as ET

def adb(*args):
    return subprocess.run(["adb", *args], capture_output=True, text=True).stdout

def nodes():
    adb("shell", "uiautomator", "dump", "/sdcard/ui.xml")
    xml = adb("shell", "cat", "/sdcard/ui.xml")
    try:
        root = ET.fromstring(xml[xml.index("<?xml"):] if "<?xml" in xml else xml)
    except Exception:
        return []
    return list(root.iter("node"))

def find(pattern):
    rx = re.compile(pattern, re.I)
    for n in nodes():
        label = (n.get("text") or "") + "|" + (n.get("content-desc") or "")
        if rx.search(label):
            x1, y1, x2, y2 = map(int, re.findall(r"\d+", n.get("bounds")))
            return (x1 + x2) // 2, (y1 + y2) // 2
    return None

def tap(pattern, scrolls=4, wait=20):
    deadline = time.time() + wait
    while True:
        for i in range(scrolls + 1):
            hit = find(pattern)
            if hit:
                adb("shell", "input", "tap", str(hit[0]), str(hit[1]))
                print("tap", pattern, hit)
                return True
            adb("shell", "input", "swipe", "540", "1700", "540", "700", "400")
            time.sleep(0.8)
        if time.time() > deadline:
            print("NOT FOUND", pattern)
            return False
        for _ in range(scrolls):
            adb("shell", "input", "swipe", "540", "700", "540", "1700", "300")
        time.sleep(1)

if __name__ == "__main__":
    cmd, pattern = sys.argv[1], sys.argv[2]
    ok = tap(pattern) if cmd == "tap" else bool(find(pattern))
    sys.exit(0 if ok else 1)
