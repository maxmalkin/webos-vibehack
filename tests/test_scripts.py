"""Tests for lgtv.py, sync-apps.py and home-watch.py against a fake TV. No TV or websockets needed.

    python3 -m unittest discover -s tests
"""
import asyncio
import contextlib
import importlib.util
import io
import json
import os
import runpy
import ssl
import sys
import tempfile
import time
import types
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
sys.modules.setdefault("websockets", types.SimpleNamespace(connect=None, WebSocketException=Exception))

import lgtv  # noqa: E402


def load(name, file):
    spec = importlib.util.spec_from_file_location(name, ROOT / file)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


sync_apps = load("sync_apps", "sync-apps.py")
home_watch = load("home_watch", "home-watch.py")


class FakeTV:
    """A websocket to the TV: answers requests from `routes` (uri -> payload) and plays `incoming`."""

    def __init__(self, incoming=(), routes=None):
        self.incoming = [json.dumps(m) for m in incoming]
        self.routes = routes or {}
        self.sent = []
        self.closed = False

    async def send(self, raw):
        msg = json.loads(raw)
        self.sent.append(msg)
        if msg.get("type") == "request" and msg["uri"] in self.routes:
            self.incoming.append(json.dumps({"type": "response", "id": msg["id"], "payload": self.routes[msg["uri"]]}))

    async def recv(self):
        return self.incoming.pop(0)

    def __aiter__(self):
        return self

    async def __anext__(self):
        if not self.incoming:
            raise StopAsyncIteration
        return self.incoming.pop(0)

    async def close(self):
        self.closed = True


def run(coro):
    return asyncio.run(coro)


class TempDirTest(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        self.addCleanup(lambda: __import__("shutil").rmtree(self.tmp))


# ---- lgtv.py ---------------------------------------------------------------------------------

class LgtvTest(TempDirTest):
    def setUp(self):
        super().setUp()
        self.key_file = self.tmp / "keys.json"
        patcher = mock.patch.object(lgtv, "KEY_FILE", str(self.key_file))
        patcher.start()
        self.addCleanup(patcher.stop)

    def connect(self, ws):
        return mock.patch.object(lgtv.websockets, "connect", mock.AsyncMock(return_value=ws), create=True)

    def test_first_pairing_waits_for_the_prompt_and_saves_the_key(self):
        ws = FakeTV([{"type": "response", "id": "register_0", "payload": {"pairingType": "PROMPT"}},
                     {"type": "registered", "id": "register_0", "payload": {"client-key": "KEY1"}}])
        self.key_file.write_text(json.dumps({"10.0.0.9": "OTHER"}))
        with self.connect(ws) as connect, contextlib.redirect_stdout(io.StringIO()) as out:
            self.assertIs(run(lgtv.session("10.0.0.5", ping_interval=10)), ws)
        register = ws.sent[0]
        self.assertEqual(register["type"], "register")
        self.assertNotIn("client-key", register["payload"])
        self.assertEqual(register["payload"]["pairingType"], "PROMPT")
        self.assertEqual(register["payload"]["manifest"]["permissions"], lgtv.PERMISSIONS)
        self.assertNotIn("signatures", register["payload"]["manifest"])   # unsigned on purpose
        self.assertIn("Accept the prompt", out.getvalue())
        self.assertEqual(json.loads(self.key_file.read_text()), {"10.0.0.9": "OTHER", "10.0.0.5": "KEY1"})
        url = connect.call_args.args[0]
        kwargs = connect.call_args.kwargs
        self.assertEqual(url, "wss://10.0.0.5:3001")
        self.assertEqual(kwargs["ssl"].verify_mode, ssl.CERT_NONE)
        self.assertEqual(kwargs["ping_interval"], 10)

    def test_a_saved_key_is_sent_and_not_rewritten(self):
        self.key_file.write_text(json.dumps({"10.0.0.5": "KEY1"}))
        os.utime(self.key_file, (0, 0))
        ws = FakeTV([{"type": "registered", "payload": {"client-key": "KEY1"}}])
        with self.connect(ws):
            run(lgtv.session("10.0.0.5"))
        self.assertEqual(ws.sent[0]["payload"]["client-key"], "KEY1")
        self.assertEqual(self.key_file.stat().st_mtime, 0)

    def test_a_new_key_from_the_tv_replaces_the_old_one(self):
        self.key_file.write_text(json.dumps({"10.0.0.5": "OLD"}))
        with self.connect(FakeTV([{"type": "registered", "payload": {"client-key": "NEW"}}])):
            run(lgtv.session("10.0.0.5"))
        self.assertEqual(json.loads(self.key_file.read_text()), {"10.0.0.5": "NEW"})

    def test_a_rejected_pairing_exits_with_the_reason(self):
        ws = FakeTV([{"type": "error", "error": "403 Pairing rejected"}])
        with self.connect(ws), contextlib.redirect_stdout(io.StringIO()):
            with self.assertRaises(SystemExit) as e:
                run(lgtv.session("10.0.0.5"))
        self.assertIn("403 Pairing rejected", str(e.exception))
        self.assertTrue(ws.closed)
        self.assertFalse(self.key_file.exists())

    def test_missing_or_corrupt_key_file_means_no_keys(self):
        self.assertEqual(lgtv.load_keys(), {})
        self.key_file.write_text("{not json")
        self.assertEqual(lgtv.load_keys(), {})

    def test_call_returns_its_own_response_and_skips_others(self):
        async def go():
            ws = FakeTV([{"type": "response", "id": "someone-else", "payload": {"x": 1}}],
                        routes={"ssap://a": {"a": 1}, "ssap://b": {"b": 2}})
            first = await lgtv.call(ws, "ssap://a", {"q": 1})
            second = await lgtv.call(ws, "ssap://b")
            return ws, first, second

        ws, first, second = run(go())
        self.assertEqual((first, second), ({"a": 1}, {"b": 2}))
        self.assertEqual(ws.sent[0]["payload"], {"q": 1})
        self.assertEqual(ws.sent[1]["payload"], {})
        self.assertNotEqual(ws.sent[0]["id"], ws.sent[1]["id"])

    def test_insecure_context_skips_certificate_checks(self):
        ctx = lgtv.insecure_ctx()
        self.assertFalse(ctx.check_hostname)
        self.assertEqual(ctx.verify_mode, ssl.CERT_NONE)


# ---- sync-apps.py ----------------------------------------------------------------------------

LAUNCH_POINTS = [
    {"id": "netflix", "title": "Netflix", "largeIcon": "http://tv/netflix-large.png", "icon": "http://tv/n.png",
     "iconColor": "#e50914"},
    {"id": "com.webos.app.browser", "title": "Web Browser", "largeIcon": "/usr/palm/large.png",
     "icon": "http://tv/browser.png", "bgColor": "#e54b4b"},
    {"id": "weird id/with:chars", "title": "Ünïcode Ápp", "icon": "http://tv/weird.png"},
    {"id": "com.webos.app.hidden", "title": "Hidden", "icon": "http://tv/hidden.png", "hidden": True},
    {"id": "broken", "title": "Broken", "icon": "http://tv/broken.png"},
]
INPUTS = [{"id": "HDMI_1", "label": "PlayStation", "appId": "com.webos.app.hdmi1"},
          {"id": "HDMI_2", "label": "", "appId": "com.webos.app.hdmi2"},
          {"id": "AV_1", "label": "AV"}]


class SyncAppsTest(TempDirTest):
    def sync(self, list_only=False, points=LAUNCH_POINTS):
        tv = FakeTV(routes={"ssap://com.webos.applicationManager/listLaunchPoints": {"launchPoints": points},
                            "ssap://tv/getExternalInputList": {"devices": INPUTS}})
        fetched = []

        def urlopen(url, context=None, timeout=None):
            fetched.append(url)
            if "broken" in url:
                raise OSError("404")
            return io.BytesIO(b"PNG:" + url.encode())

        out = io.StringIO()
        with mock.patch.object(lgtv, "session", mock.AsyncMock(return_value=tv)) as session, \
                mock.patch.object(sync_apps, "APP_DIR", str(self.tmp)), \
                mock.patch.object(sync_apps.urllib.request, "urlopen", urlopen), \
                contextlib.redirect_stdout(out):
            run(sync_apps.main("10.0.0.5", list_only))
        session.assert_awaited_once_with("10.0.0.5")
        self.assertTrue(tv.closed)
        return out.getvalue(), fetched

    def generated(self):
        text = (self.tmp / "apps.js").read_text(encoding="utf-8")
        self.assertTrue(text.startswith("// Generated by sync-apps.py"))
        prefix = "window.TV_APPS = "
        body = text[text.index(prefix) + len(prefix):].rstrip().rstrip(";")
        return text, json.loads(body)

    def test_writes_visible_apps_with_their_icons(self):
        out, fetched = self.sync()
        text, data = self.generated()
        self.assertEqual([a["id"] for a in data["apps"]], ["netflix", "com.webos.app.browser", "weird id/with:chars"])
        netflix, browser, weird = data["apps"]
        self.assertEqual(netflix, {"id": "netflix", "title": "Netflix", "icon": "icons/netflix.png", "iconColor": "#e50914"})
        self.assertEqual(browser["iconColor"], "#e54b4b", "falls back to bgColor")
        self.assertEqual(weird["icon"], "icons/weird_id_with_chars.png", "file name made safe")
        self.assertEqual(weird["iconColor"], "")
        self.assertIn("Ünïcode Ápp", text, "titles kept as written")
        self.assertEqual((self.tmp / "icons" / "netflix.png").read_bytes(), b"PNG:http://tv/netflix-large.png")
        self.assertEqual((self.tmp / "icons" / "com.webos.app.browser.png").read_bytes(), b"PNG:http://tv/browser.png",
                         "a non-http largeIcon falls back to icon")
        self.assertNotIn("http://tv/hidden.png", fetched)
        self.assertIn("no icon for broken", out)
        self.assertIn("Synced 3 apps and 2 inputs.", out)

    def test_writes_inputs_that_can_be_opened(self):
        self.sync()
        _, data = self.generated()
        self.assertEqual(data["inputs"], [{"appId": "com.webos.app.hdmi1", "label": "PlayStation"},
                                          {"appId": "com.webos.app.hdmi2", "label": "HDMI_2"}])

    def test_list_prints_every_app_and_writes_nothing(self):
        out, fetched = self.sync(list_only=True)
        self.assertEqual(fetched, [])
        self.assertFalse((self.tmp / "apps.js").exists())
        lines = out.splitlines()
        self.assertEqual(len(lines), len(LAUNCH_POINTS))
        self.assertTrue(lines[0].startswith("netflix ") and lines[0].endswith("Netflix"))
        self.assertIn("Hidden", out)

    def test_closes_the_connection_when_the_tv_errors(self):
        tv = FakeTV()
        with mock.patch.object(lgtv, "session", mock.AsyncMock(return_value=tv)), \
                mock.patch.object(lgtv, "call", mock.AsyncMock(side_effect=OSError("gone"))):
            with self.assertRaises(OSError):
                run(sync_apps.main("10.0.0.5", False))
        self.assertTrue(tv.closed)


# ---- home-watch.py ---------------------------------------------------------------------------

def fg(app, id_="fg"):
    return {"type": "response", "id": id_, "payload": {"appId": app}}


class HomeWatchTest(unittest.TestCase):
    def watch(self, messages, times):
        tv = FakeTV(messages)
        clock = types.SimpleNamespace(monotonic=mock.Mock(side_effect=times), strftime=time.strftime)
        with mock.patch.object(lgtv, "session", mock.AsyncMock(return_value=tv)) as session, \
                mock.patch.object(home_watch, "time", clock), contextlib.redirect_stdout(io.StringIO()) as out:
            run(home_watch.watch("10.0.0.5"))
        session.assert_awaited_once_with("10.0.0.5", ping_interval=10, ping_timeout=10)
        self.assertTrue(tv.closed)
        launches = [m for m in tv.sent if m.get("uri") == "ssap://system.launcher/launch"]
        return tv, launches, out.getvalue()

    def test_subscribes_to_the_foreground_app(self):
        tv, _, _ = self.watch([], [])
        self.assertEqual(tv.sent[0]["type"], "subscribe")
        self.assertEqual(tv.sent[0]["uri"], "ssap://com.webos.applicationManager/getForegroundAppInfo")

    def test_lg_home_opens_the_launcher(self):
        _, launches, _ = self.watch([fg("netflix"), fg(home_watch.LG_HOME), fg(home_watch.LAUNCHER)], [100.0])
        self.assertEqual(len(launches), 1)
        self.assertEqual(launches[0]["payload"], {"id": "com.gathin.tvhome"})

    def test_ignores_other_apps_and_other_messages(self):
        _, launches, _ = self.watch([fg("netflix"), fg(home_watch.LG_HOME, id_="something-else"),
                                     {"type": "response", "id": "fg", "payload": {}}], [])
        self.assertEqual(launches, [])

    def test_home_twice_quickly_stays_on_lg_home_once(self):
        home = fg(home_watch.LG_HOME)
        # 2nd within 3 s: stay. 3rd: the escape was used up, redirect again. 4th much later: redirect.
        _, launches, out = self.watch([home, home, home, home], [100.0, 101.5, 102.0, 200.0])
        self.assertEqual(len(launches), 3)
        self.assertIn("Home pressed twice", out)

    def test_home_again_after_the_window_redirects(self):
        home = fg(home_watch.LG_HOME)
        _, launches, _ = self.watch([home, home], [100.0, 100.0 + home_watch.ESCAPE_SECONDS])
        self.assertEqual(len(launches), 2)

    def test_reconnects_with_backoff_when_the_tv_is_away(self):
        class Stop(Exception):
            pass

        delays = []

        async def sleep(s):
            delays.append(s)
            if len(delays) == 6:
                raise Stop

        outcomes = [OSError("off"), asyncio.TimeoutError(), lgtv.websockets.WebSocketException("x"), OSError("off"),
                    None, OSError("off")]
        with mock.patch.object(home_watch, "watch", mock.AsyncMock(side_effect=outcomes)), \
                mock.patch.object(home_watch.asyncio, "sleep", sleep), contextlib.redirect_stdout(io.StringIO()):
            with self.assertRaises(Stop):
                run(home_watch.main("10.0.0.5"))
        self.assertEqual(delays, [10, 20, 20, 20, 5, 10])


# ---- command lines ---------------------------------------------------------------------------

class CommandLineTest(unittest.TestCase):
    def main_args(self, script, argv, env):
        """Runs a script as __main__ and returns the arguments its main() coroutine got."""
        got = {}

        def fake_run(coro):
            got.update(coro.cr_frame.f_locals)
            coro.close()

        with mock.patch.object(sys, "argv", [script, *argv]), mock.patch.dict(os.environ, env, clear=True), \
                mock.patch.object(asyncio, "run", fake_run):
            runpy.run_path(str(ROOT / script), run_name="__main__")
        return got

    def test_sync_apps_arguments(self):
        self.assertEqual(self.main_args("sync-apps.py", ["10.0.0.5"], {}), {"host": "10.0.0.5", "list_only": False})
        self.assertEqual(self.main_args("sync-apps.py", ["--list", "10.0.0.5"], {}), {"host": "10.0.0.5", "list_only": True})
        self.assertEqual(self.main_args("sync-apps.py", [], {"TV_HOST": "10.0.0.7"})["host"], "10.0.0.7")
        with self.assertRaises(SystemExit) as e:
            self.main_args("sync-apps.py", [], {})
        self.assertIn("usage", str(e.exception))

    def test_home_watch_arguments(self):
        self.assertEqual(self.main_args("home-watch.py", ["10.0.0.5"], {})["host"], "10.0.0.5")
        self.assertEqual(self.main_args("home-watch.py", [], {"TV_HOST": "10.0.0.7"})["host"], "10.0.0.7")
        with self.assertRaises(SystemExit) as e:
            self.main_args("home-watch.py", [], {})
        self.assertIn("usage", str(e.exception))


if __name__ == "__main__":
    unittest.main()
