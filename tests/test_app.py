import concurrent.futures
import datetime as dt
import json
from pathlib import Path
import sys
import tempfile
import threading
import unittest
from unittest.mock import patch
from urllib.error import HTTPError
from urllib.request import Request, urlopen
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from app import Engine, ModelError, Provider, LocalServer, make_handler


class Clock:
    def __init__(self):
        self.now = dt.datetime(2026, 10, 20, 12, tzinfo=dt.timezone(dt.timedelta(hours=8))).timestamp()
    def __call__(self):
        return self.now


class FakeProvider:
    demo = True
    model = 'test'
    def complete(self, *_):
        raise AssertionError('Demo must not call a remote provider')


class EngineTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.path = Path(self.temp.name) / 'test.sqlite3'
        self.clock = Clock()
        self.engine = Engine(self.path, FakeProvider(), self.clock)
    def tearDown(self):
        self.temp.cleanup()
    def test_memory_and_emotion_survive_restart(self):
        self.engine.chat('我喜欢雨天，谢谢你。', 'one')
        old = self.engine.snapshot()
        restored = Engine(self.path, FakeProvider(), self.clock).snapshot()
        self.assertEqual(old['memories'], restored['memories'])
        self.assertEqual(old['messages'], restored['messages'])
        self.assertGreater(restored['mood']['valence'], .6)
    def test_recall_after_short_term_context_is_cleared(self):
        self.engine.chat('记住：我习惯晚上读书。', 'a')
        self.engine.clear_history()
        result = self.engine.chat('你还记得我读书的习惯吗？', 'b')
        self.assertIn('晚上读书', result['reply'])
    def test_preference_correction_replaces_prior_fact(self):
        self.engine.chat('我喜欢咖啡。', 'a')
        self.engine.chat('我不喜欢咖啡。', 'b')
        memories = self.engine.snapshot()['memories']
        self.assertEqual(len(memories), 1)
        self.assertEqual(memories[0]['content'], '我不喜欢咖啡')
    def test_names_replace_prior_name(self):
        self.engine.chat('我叫小李。', 'a')
        self.engine.chat('以后叫我小林。', 'b')
        self.assertEqual(len(self.engine.snapshot()['memories']), 1)
    def test_idempotent_retry(self):
        first = self.engine.chat('我喜欢猫。', 'same')
        self.assertEqual(first, self.engine.chat('我喜欢猫。', 'same'))
        self.assertEqual(len(self.engine.snapshot()['messages']), 2)
        with self.assertRaises(ValueError):
            self.engine.chat('different', 'same')
    def test_forget_invalidates_old_context(self):
        self.engine.chat('我喜欢雨天。', 'a')
        memory = self.engine.snapshot()['memories'][0]
        self.engine.change_memory({'id': memory['id']}, delete=True)
        self.assertEqual(self.engine.snapshot()['memories'], [])
        with self.engine.db() as con:
            self.assertEqual(self.engine.get(con, 'context_floor'), 2)
        self.assertNotIn('我喜欢雨天', self.engine.snapshot()['messages'][0]['content'])
        self.assertNotIn('雨天', self.engine.chat('你记得我喜欢什么吗？', 'b')['reply'])
    def test_manual_correction(self):
        self.engine.chat('我喜欢雨天。', 'a')
        mid = self.engine.snapshot()['memories'][0]['id']
        self.engine.change_memory({'id': mid, 'content': '用户喜欢晴天'})
        row = self.engine.snapshot()['memories'][0]
        self.assertEqual(row['origin'], 'manual')
        self.assertIsNone(row['source_id'])
        self.assertIn('晴天', self.engine.chat('你记得我喜欢什么吗？', 'b')['reply'])
    def test_hypothetical_not_rule_memory(self):
        self.engine.chat('假如我喜欢咖啡，你会怎么说？', 'a')
        self.assertEqual(self.engine.snapshot()['memories'], [])
    def test_manual_change_does_not_keep_old_auto_merge_key(self):
        self.engine.chat('我喜欢雨天。', 'a')
        mid = self.engine.snapshot()['memories'][0]['id']
        self.engine.change_memory({'id': mid, 'content': '用户喜欢晴天'})
        self.engine.chat('我不喜欢雨天。', 'b')
        self.assertEqual(len(self.engine.snapshot()['memories']), 2)
    def test_recall_question_does_not_become_a_new_preference(self):
        self.engine.chat('你记得我喜欢什么吗？', 'a')
        self.assertEqual(self.engine.snapshot()['memories'], [])
    def test_mood_decays_without_new_message(self):
        self.engine.chat('今天成功了，真开心！', 'a')
        initial = self.engine.snapshot()['mood']['valence']
        self.clock.now += 12 * 3600
        decayed = self.engine.snapshot()['mood']['valence']
        self.assertLess(decayed, initial)
        self.assertGreater(decayed, .6)
    def test_reminder_survives_restart_exactly_once(self):
        self.engine.add_task('喝水', self.clock.now + 10)
        restored = Engine(self.path, FakeProvider(), self.clock)
        self.clock.now += 11
        restored.tick()
        restored.tick()
        again = Engine(self.path, FakeProvider(), self.clock)
        again.tick()
        self.assertEqual(len(again.snapshot()['messages']), 1)
        self.assertEqual(again.snapshot()['tasks'][0]['status'], 'delivered')
    def test_parallel_instances_do_not_duplicate_reminder(self):
        self.engine.add_task('喝水', self.clock.now + 1)
        other = Engine(self.path, FakeProvider(), self.clock)
        self.clock.now += 2
        with concurrent.futures.ThreadPoolExecutor() as pool:
            list(pool.map(lambda engine: engine.tick(), [self.engine, other]))
        self.assertEqual(len(self.engine.snapshot()['messages']), 1)
    def test_pause_and_quiet_hours_defer_not_drop(self):
        self.engine.add_task('喝水', self.clock.now + 1)
        self.engine.save_settings({'proactive_enabled': False})
        self.clock.now += 2
        self.engine.tick()
        self.assertEqual(len(self.engine.snapshot()['messages']), 0)
        self.engine.save_settings({'proactive_enabled': True, 'quiet_start': 11, 'quiet_end': 13})
        self.engine.tick()
        self.assertEqual(len(self.engine.snapshot()['messages']), 0)
        self.clock.now += 2 * 3600
        self.engine.tick()
        self.assertEqual(len(self.engine.snapshot()['messages']), 1)
    def test_overnight_quiet_hours(self):
        s = self.engine.snapshot()['settings']
        self.assertFalse(self.engine.quiet(s, self.clock.now))
        self.assertTrue(self.engine.quiet(s, self.clock.now + 12 * 3600))
        s['quiet_start'] = s['quiet_end']
        self.assertFalse(self.engine.quiet(s, self.clock.now + 12 * 3600))
    def test_cancelled_task_never_delivered(self):
        task = self.engine.add_task('取消我', self.clock.now + 1)
        self.engine.cancel_task(task['id'])
        self.clock.now += 2
        self.engine.tick()
        self.assertEqual(self.engine.snapshot()['messages'], [])
    def test_idle_limit_survives_restart(self):
        self.engine.save_settings({'idle_enabled': True, 'idle_minutes': 1, 'daily_limit': 1})
        self.clock.now += 61
        self.engine.tick()
        self.clock.now += 61
        restored = Engine(self.path, FakeProvider(), self.clock)
        restored.tick()
        self.assertEqual(len(restored.snapshot()['messages']), 1)
        self.assertEqual(restored.snapshot()['messages'][0]['kind'], 'proactive')
    def test_idle_disabled_by_default(self):
        self.clock.now += 3 * 3600
        self.engine.tick()
        self.assertEqual(self.engine.snapshot()['messages'], [])
    def test_provider_failure_has_no_partial_write(self):
        self.engine.provider.demo = False
        self.engine.provider.complete = lambda *_: (_ for _ in ()).throw(ModelError('offline'))
        with self.assertRaises(ModelError):
            self.engine.chat('我喜欢猫。', 'a')
        self.assertEqual(self.engine.snapshot()['messages'], [])
        self.assertEqual(self.engine.snapshot()['memories'], [])
    def test_model_extraction_uses_only_exact_user_evidence(self):
        self.engine.provider.demo = False
        payload = {'reply':'好的。', 'memories':[{'category':'episode','evidence':'今天我去了杭州'}, {'category':'fact','evidence':'用户拥有一栋别墅'}]}
        self.engine.provider.complete = lambda *_: json.dumps(payload)
        self.engine.chat('今天我去了杭州。', 'a')
        memories = self.engine.snapshot()['memories']
        self.assertEqual(len(memories), 1)
        self.assertEqual(memories[0]['content'], '今天我去了杭州')
    def test_invalid_inputs_rejected(self):
        for value in (float('nan'), float('inf'), True, -1):
            with self.assertRaises(ValueError):
                self.engine.add_task('invalid', value)
        with self.assertRaises(ValueError):
            self.engine.save_settings({'idle_minutes': 0})
        with self.assertRaises(ValueError):
            self.engine.chat('', 'a')
    def test_export_contains_full_history(self):
        self.engine.chat('我喜欢猫。', 'a')
        exported = self.engine.export()
        self.assertEqual(exported['format'], 'companion-mvp-v1')
        self.assertEqual(len(exported['messages']), 2)
        self.assertNotIn('api_key', json.dumps(exported))


class HTTPTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.engine = Engine(Path(self.temp.name)/'db.sqlite3', FakeProvider())
        self.server = LocalServer(('127.0.0.1', 0), make_handler(self.engine))
        self.base = f'http://127.0.0.1:{self.server.server_port}'
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join()
        self.temp.cleanup()
    def test_static_and_http_roundtrip(self):
        with urlopen(self.base) as result:
            self.assertEqual(result.status, 200)
            self.assertIn('frame-ancestors', result.headers['Content-Security-Policy'])
        request = Request(self.base+'/api/chat', json.dumps({'message':'我喜欢猫。','request_id':'http'}).encode(), {'Content-Type':'application/json','Origin':self.base})
        with urlopen(request) as result:
            self.assertIn('记下', json.load(result)['reply'])
        with urlopen(self.base+'/api/state') as result:
            self.assertEqual(len(json.load(result)['memories']), 1)
    def test_cross_origin_write_rejected(self):
        request = Request(self.base+'/api/history/clear', b'{}', {'Content-Type':'application/json','Origin':'https://attacker.example'})
        with self.assertRaises(HTTPError) as exc:
            urlopen(request)
        self.assertEqual(exc.exception.code, 403)
        exc.exception.close()
    def test_dns_rebinding_host_rejected(self):
        request = Request(self.base+'/api/state', headers={'Host':'attacker.example'})
        with self.assertRaises(HTTPError) as exc:
            urlopen(request)
        self.assertEqual(exc.exception.code, 403)
        exc.exception.close()
    def test_path_traversal_rejected(self):
        with self.assertRaises(HTTPError) as exc:
            urlopen(self.base+'/../.env')
        self.assertEqual(exc.exception.code, 404)
        exc.exception.close()


class ProviderContractTests(unittest.TestCase):
    def test_both_wire_protocols_against_mock_server(self):
        captures = []
        class Mock(BaseHTTPRequestHandler):
            def log_message(self, *_):
                pass
            def do_POST(self):
                payload = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
                captures.append((self.path, payload))
                reply = {'output':[{'type':'message','content':[{'type':'output_text','text':'你好'}]}]} if self.path.endswith('/responses') else {'choices':[{'message':{'content':'你好'}}]}
                raw = json.dumps(reply).encode()
                self.send_response(200)
                self.send_header('Content-Length', str(len(raw)))
                self.end_headers()
                self.wfile.write(raw)
        server = ThreadingHTTPServer(('127.0.0.1',0), Mock)
        thread = threading.Thread(target=server.serve_forever,daemon=True)
        thread.start()
        try:
            for style in ('responses','chat_completions'):
                with patch.dict('os.environ', {'CHAT_MODE':'live','LLM_MODEL':'mock','LLM_BASE_URL':f'http://127.0.0.1:{server.server_port}/v1','LLM_API_STYLE':style,'LLM_API_KEY':''}):
                    provider=Provider()
                    self.assertEqual(provider.complete('system',[{'role':'user','content':'hello'}]), '你好')
            self.assertFalse(captures[0][1]['store'])
            self.assertEqual(captures[0][0], '/v1/responses')
            self.assertEqual(captures[1][0], '/v1/chat/completions')
        finally:
            server.shutdown();server.server_close();thread.join()


if __name__ == '__main__':
    unittest.main(verbosity=2)
