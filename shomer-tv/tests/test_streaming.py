"""Escalera HLS, catálogo de canales y la lista que ve el reproductor."""
import json
import os
import tempfile
import unittest

from shomer_tv.catalog import channel_command, load_catalog, present_channels
from shomer_tv.ladder import (
    even_dimensions, parse_bitrate, parse_master, render_master, resolve_variant_uri,
    select_renditions, write_master, Variant,
)
from shomer_tv.server import list_channels

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


class LadderTests(unittest.TestCase):
    def test_720_no_incluye_1080(self):
        heights = [r.height for r in select_renditions(720)]
        self.assertEqual(heights, [720, 480, 360])

    def test_no_amplia_un_cuadro_pequeno(self):
        only = select_renditions(240)
        self.assertEqual(len(only), 1)
        self.assertEqual(only[0].height, 240)

    def test_proporcion_par(self):
        self.assertEqual(even_dimensions(1280, 720, 720), (1280, 720))
        self.assertEqual(even_dimensions(1280, 720, 480), (854, 480))
        self.assertEqual(even_dimensions(1280, 720, 360), (640, 360))

    def test_bitrate(self):
        self.assertEqual(parse_bitrate("2500k"), 2_500_000)
        self.assertEqual(parse_bitrate("4.5m"), 4_500_000)
        self.assertEqual(parse_bitrate("128000"), 128_000)

    def test_lista_maestra_redonda(self):
        variants = [
            Variant("720p", 1280, 720, 2_800_000, "720p/index.m3u8"),
            Variant("480p", 854, 480, 1_400_000, "480p/index.m3u8"),
        ]
        text = render_master(variants)
        self.assertNotIn("\\", text)
        parsed = parse_master(text)
        self.assertEqual([p["name"] for p in parsed], ["720p", "480p"])
        self.assertEqual(parsed[0]["bandwidth"], 2_800_000)
        self.assertEqual(parsed[1]["uri"], "480p/index.m3u8")

    def test_lista_de_ffmpeg_sin_name(self):
        text = (
            "#EXTM3U\n"
            '#EXT-X-STREAM-INF:BANDWIDTH=1400000,AVERAGE-BANDWIDTH=1200000,'
            'RESOLUTION=854x480,CODECS="avc1.64001f,mp4a.40.2"\n'
            "480p/index.m3u8\n"
        )
        parsed = parse_master(text)
        self.assertEqual(parsed[0]["resolution"], "854x480")
        self.assertEqual(parsed[0]["bandwidth"], 1_400_000)
        self.assertEqual(parsed[0]["name"], "854x480")
        self.assertEqual(parsed[0]["uri"], "480p/index.m3u8")

    def test_uri_no_sale_del_canal(self):
        with tempfile.TemporaryDirectory() as d:
            self.assertIsNone(resolve_variant_uri(d, "../secreto"))
            self.assertIsNone(resolve_variant_uri(d, "/etc/passwd"))
            full = resolve_variant_uri(d, "720p/index.m3u8")
            self.assertTrue(full.startswith(os.path.abspath(d)))

    def test_write_master_atomico(self):
        with tempfile.TemporaryDirectory() as d:
            path = os.path.join(d, "index.m3u8")
            write_master(path, [Variant("360p", 640, 360, 900_000, "360p/index.m3u8")])
            self.assertIn("360p/index.m3u8", open(path, encoding="utf-8").read())


class CatalogTests(unittest.TestCase):
    def test_catalogo_del_repo(self):
        cat = load_catalog(os.path.join(ROOT, "channels.json"))
        self.assertEqual([c.name for c in cat.channels], ["canal-1", "canal-2", "canal-3"])
        self.assertTrue(cat.channels[0].listen)
        self.assertIn("1935", cat.channels[0].input)
        self.assertIn("1936", cat.channels[1].input)
        self.assertFalse(cat.channels[2].listen)
        self.assertTrue(cat.channels[2].input.startswith("srt://"))
        self.assertTrue(all(c.abr and c.retry for c in cat.channels))

    def test_nombre_duplicado(self):
        with tempfile.TemporaryDirectory() as d:
            path = os.path.join(d, "c.json")
            json.dump({"channels": [
                {"name": "canal-1", "input": "rtmp://0.0.0.0:1935/live/a"},
                {"name": "canal-1", "input": "rtmp://0.0.0.0:1936/live/b"},
            ]}, open(path, "w", encoding="utf-8"))
            with self.assertRaises(ValueError):
                load_catalog(path)

    def test_comando_por_protocolo(self):
        cat = load_catalog(os.path.join(ROOT, "channels.json"))
        rtmp = channel_command(cat.channels[0], "hls", "python")
        srt = channel_command(cat.channels[2], "hls", "python")
        self.assertIn("--listen", rtmp)
        self.assertNotIn("--listen", srt)
        self.assertIn("--retry", rtmp)
        self.assertIn("srt://0.0.0.0:8890?mode=listener", srt)
        plain = cat.channels[0].__class__(**{**cat.channels[0].__dict__, "abr": False})
        self.assertIn("--no-abr", channel_command(plain, "hls"))

    def test_presenta_esperando_y_oculta_la_entrada(self):
        cat = load_catalog(os.path.join(ROOT, "channels.json"))
        found = [{"name": "canal-2", "state": "live", "url": "/hls/canal-2/index.m3u8",
                  "variants": [{"name": "720p", "url": "/hls/canal-2/720p/index.m3u8"}],
                  "vod": False, "ad": False}]
        public = present_channels(found, list(cat.channels))
        self.assertEqual([c["name"] for c in public], ["canal-1", "canal-2", "canal-3"])
        self.assertEqual(public[0]["state"], "waiting")
        self.assertIsNone(public[0]["url"])
        self.assertEqual(public[1]["title"], "Partido B")
        self.assertNotIn("ingest", public[1])
        private = present_channels(found, list(cat.channels), include_ingest=True)
        self.assertIn("1936", private[1]["ingest"])


class ChannelListTests(unittest.TestCase):
    def test_maestro_y_lista_vieja(self):
        with tempfile.TemporaryDirectory() as root:
            os.makedirs(os.path.join(root, "partido", "720p"))
            with open(os.path.join(root, "partido", "index.m3u8"), "w", encoding="utf-8") as f:
                f.write(render_master([
                    Variant("720p", 1280, 720, 2_800_000, "720p/index.m3u8"),
                    Variant("360p", 640, 360, 900_000, "360p/index.m3u8"),
                ]))
            with open(os.path.join(root, "partido", "720p", "index.m3u8"), "w", encoding="utf-8") as f:
                f.write("#EXTM3U\n#EXT-X-ENDLIST\n")
            with open(os.path.join(root, "partido", "status.json"), "w", encoding="utf-8") as f:
                json.dump({"state": "ended", "frames": 10}, f)
            os.makedirs(os.path.join(root, "viejo"))
            with open(os.path.join(root, "viejo", "index.m3u8"), "w", encoding="utf-8") as f:
                f.write("#EXTM3U\n#EXTINF:2,\nseg_00000.ts\n#EXT-X-ENDLIST\n")
            os.makedirs(os.path.join(root, ".control"))
            rows = list_channels(root)
            by = {r["name"]: r for r in rows}
            self.assertNotIn(".control", by)
            self.assertTrue(by["partido"]["vod"])
            self.assertEqual([v["name"] for v in by["partido"]["variants"]], ["720p", "360p"])
            self.assertEqual(by["partido"]["variants"][0]["url"], "/hls/partido/720p/index.m3u8")
            self.assertEqual(by["viejo"]["variants"], [])
            self.assertTrue(by["viejo"]["vod"])
            self.assertFalse(any("ingest" in r for r in rows))


if __name__ == "__main__":
    unittest.main()
