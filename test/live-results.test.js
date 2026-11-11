import test from 'node:test';
import assert from 'node:assert/strict';
import { LiveResults } from '../web/live-results.js';

function setup(fetchResults) {
  const timers = [], data = [], errors = [];
  const poller = new LiveResults({ fetchResults, onData: value => data.push(value), onError: error => errors.push(error),
    schedule: (fn, delay) => { const timer = { fn, delay }; timers.push(timer); return timer; }, cancel: timer => { if (timer) timer.cancelled = true; } });
  return { poller, timers, data, errors };
}

test('polls every five seconds and delivers changed results after initial load', async () => {
  let version = 0;
  const { poller, timers, data } = setup(async () => ({ revision: ++version }));
  poller.start();
  assert.equal(timers[0].delay, 5000);
  await timers[0].fn(); await timers[1].fn();
  assert.deepEqual(data, [{ revision: 1 }, { revision: 2 }]);
  poller.stop(); assert.equal(timers.at(-1).cancelled, true);
});

test('temporary failures retry without replacing the last successful data', async () => {
  let calls = 0;
  const { poller, timers, data, errors } = setup(async () => { if (++calls === 2) throw new Error('offline'); return calls; });
  poller.start(); await timers[0].fn(); await timers[1].fn(); await timers[2].fn();
  assert.deepEqual(data, [1, 3]); assert.equal(errors.length, 1);
  poller.stop();
});

test('source changes abort pending requests and ignore late responses', async () => {
  let finish, signal;
  const { poller, timers, data } = setup(value => { signal = value; return new Promise(resolve => { finish = resolve; }); });
  poller.start(); const pending = timers[0].fn();
  poller.refresh(); assert.equal(timers.length, 1); // No overlapping request.
  poller.stop(); assert.equal(signal.aborted, true);
  finish('old source'); await pending; assert.deepEqual(data, []);
  assert.equal(timers.length, 1);
});

test('hidden pages pause requests and visible pages can refresh immediately', async () => {
  let visible = false, requests = 0;
  const { poller, timers, data } = setup(async () => ++requests);
  poller.visible = () => visible;
  poller.start(); await timers[0].fn(); assert.equal(requests, 0);
  visible = true; await timers[1].fn(); assert.deepEqual(data, [1]);
  poller.stop();
});

test('default timer wrappers do not invoke browser timer APIs with the poller as receiver', t => {
  let poller;
  t.mock.method(globalThis, 'setTimeout', function () { assert.notEqual(this, poller); return 1; });
  t.mock.method(globalThis, 'clearTimeout', function () { assert.notEqual(this, poller); });
  poller = new LiveResults({ fetchResults: async () => ({}), onData() {}, onError() {} });
  poller.start(); poller.stop();
});
