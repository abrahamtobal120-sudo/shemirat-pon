"""Tap Android UI elements by visible text through adb + uiautomator (used by capture.sh)."""
import re, subprocess, sys, time, xml.etree.ElementTree as ET

def adb(*args):
    return subprocess.run(["adb", *args], capture_output=True, text=True).stdout

def nodes(tries=15):
    """uiautomator needs an idle screen; Shomer refreshes its counters every second, so retry."""
    for _ in range(tries):
        adb("shell", "rm", "-f", "/sdcard/ui.xml")
        out = adb("shell", "uiautomator", "dump", "/sdcard/ui.xml")
        xml = adb("shell", "cat", "/sdcard/ui.xml")
        if "<hierarchy" in xml:
            try:
                return list(ET.fromstring(xml[xml.index("<?xml"):] if "<?xml" in xml else xml).iter("node"))
            except Exception as e:
                print("xml", e)
        else:
            print("dump falló:", out.strip()[:120])
        time.sleep(0.7)
    return []

def find(pattern):
    rx = re.compile(pattern, re.I)
    for n in nodes():
        label = (n.get("text") or "") + "|" + (n.get("content-desc") or "")
        if rx.search(label):
            x1, y1, x2, y2 = map(int, re.findall(r"\d+", n.get("bounds")))
            return (x1 + x2) // 2, (y1 + y2) // 2
    return None

def tap(pattern, scrolls=4):
    for direction in ("down", "up"):
        for i in range(scrolls + 1):
            hit = find(pattern)
            if hit:
                adb("shell", "input", "tap", str(hit[0]), str(hit[1]))
                print("tap", pattern, hit)
                return True
            if i < scrolls:
                a, b = ("1700", "800") if direction == "down" else ("800", "1700")
                adb("shell", "input", "swipe", "540", a, "540", b, "400")
                time.sleep(1)
    labels = [n.get("text") for n in nodes() if n.get("text")]
    print("NOT FOUND", pattern, "| visibles:", labels[:25])
    return False

if __name__ == "__main__":
    cmd, pattern = sys.argv[1], sys.argv[2]
    ok = tap(pattern, int(sys.argv[3]) if len(sys.argv) > 3 else 4) if cmd == "tap" else bool(find(pattern))
    sys.exit(0 if ok else 1)
