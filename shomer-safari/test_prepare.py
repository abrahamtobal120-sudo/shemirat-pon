import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import prepare


class PrepareTests(unittest.TestCase):
    def test_prepares_independent_resources_without_overwriting(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            source = root / "web"
            source.mkdir()
            for name in ("common", "content", "engine", "icons", "lib", "_locales", "models", "popup", "rules"):
                (source / name).mkdir()
            (source / "background.js").write_text("background", encoding="utf-8")
            original = {"manifest_version": 3, "minimum_chrome_version": "116"}
            (source / "manifest.json").write_text(json.dumps(original), encoding="utf-8")
            output = root / "output"
            with patch.object(prepare, "SOURCE", source), \
                 patch.object(prepare, "OUTPUT", output), \
                 patch.object(prepare, "EXTENSION", output / "extension"), \
                 patch.object(prepare.sys, "platform", "darwin"), \
                 patch.object(prepare.shutil, "which", return_value="/usr/bin/xcrun"), \
                 patch.object(prepare.subprocess, "run") as converter:
                prepare.main()
                copied = json.loads((output / "extension" / "manifest.json").read_text())
                self.assertNotIn("minimum_chrome_version", copied)
                self.assertEqual(json.loads((source / "manifest.json").read_text()), original)
                self.assertIn("--copy-resources", converter.call_args.args[0])
                with self.assertRaises(SystemExit):
                    prepare.main()
                converter.assert_called_once()


if __name__ == "__main__":
    unittest.main()
