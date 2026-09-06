/**
 * The events shim, compared against node:events
 *
 * Every behavioural assertion runs against both implementations in the same
 * test, so the expectation is Node's actual behaviour rather than a belief
 * about it. A test that passes for the shim but not for Node is a broken test,
 * and says so.
 */

import assert from 'node:assert';
import nodeEvents from 'node:events';
import { EventEmitter as Shim } from './events.ts';

type AnyEmitter = nodeEvents.EventEmitter | Shim;
type EmitterClass = new () => AnyEmitter;

const implementations: Array<[string, EmitterClass]> = [
	['node', nodeEvents.EventEmitter as unknown as EmitterClass],
	['shim', Shim as unknown as EmitterClass],
];

describe.each(implementations)('%s EventEmitter', (_name, Emitter) => {
	const statics = Emitter as unknown as typeof nodeEvents.EventEmitter;

	it('runs listeners in order, with prepended ones first', () => {
		const record: string[] = [];
		const emitter = new Emitter();

		emitter.on('a', () => record.push('first'));
		emitter.on('a', () => record.push('second'));
		emitter.prependListener('a', () => record.push('prepended'));

		assert.strictEqual(emitter.emit('a'), true, 'emit reports that it had listeners');
		assert.deepStrictEqual(record, ['prepended', 'first', 'second']);
		assert.strictEqual(emitter.emit('nothing'), false, 'emit reports when nothing listened');
	});

	it('removes a once listener before calling it, so re-emitting cannot recurse', () => {
		const emitter = new Emitter();
		let count = 0;

		emitter.once('b', () => {
			count++;

			if (count < 3) {
				emitter.emit('b');
			}
		});
		emitter.emit('b');

		assert.strictEqual(count, 1, 'a once listener does not re-enter itself');
		assert.strictEqual(emitter.listenerCount('b'), 0, 'and is gone afterwards');
	});

	it('removes a once listener by its original function', () => {
		const record: string[] = [];
		const emitter = new Emitter();
		const handler = () => record.push('never');

		emitter.once('c', handler);
		emitter.removeListener('c', handler);
		emitter.emit('c');

		assert.deepStrictEqual(record, []);
	});

	it('unwraps once listeners in listeners() but not in rawListeners()', () => {
		const emitter = new Emitter();
		const plain = () => {};

		emitter.once('d', plain);

		assert.deepStrictEqual(emitter.listeners('d'), [plain], 'listeners unwraps');
		assert.strictEqual(emitter.rawListeners('d').length, 1, 'rawListeners keeps the wrapper');
		assert.deepStrictEqual(emitter.eventNames(), ['d'], 'eventNames reports registered events');
	});

	it('does not skip a listener when another is removed mid-emit', () => {
		const record: string[] = [];
		const emitter = new Emitter();
		const second = () => record.push('second');

		emitter.on('e', () => {
			emitter.removeListener('e', second);
			record.push('first');
		});
		emitter.on('e', second);
		emitter.on('e', () => record.push('third'));
		emitter.emit('e');

		assert.deepStrictEqual(record, ['first', 'second', 'third']);
	});

	it('throws an unhandled error and swallows a handled one', () => {
		const record: string[] = [];
		const emitter = new Emitter();

		assert.throws(() => emitter.emit('error', new Error('boom')), /boom/);

		emitter.on('error', () => record.push('handled'));
		emitter.emit('error', new Error('boom'));

		assert.deepStrictEqual(record, ['handled']);
	});

	it('emits newListener before recording the listener', () => {
		const record: unknown[] = [];
		const emitter = new Emitter();

		emitter.on('newListener', (event) => record.push(`new:${event}`, emitter.listenerCount('f')));
		emitter.on('f', () => {});

		assert.deepStrictEqual(record, ['new:f', 0]);
	});

	it('clears the named event, or everything', () => {
		const emitter = new Emitter();

		emitter.on('g', () => {});
		emitter.on('h', () => {});
		emitter.removeAllListeners('g');

		assert.deepStrictEqual(emitter.eventNames(), ['h'], 'only the named event is cleared');

		emitter.removeAllListeners();

		assert.deepStrictEqual(emitter.eventNames(), [], 'with no name, everything is');
	});

	it('resolves the static once with the emitted arguments', async () => {
		const emitter = new Emitter();

		setTimeout(() => emitter.emit('ready', 1, 2), 0);

		assert.deepStrictEqual(await statics.once(emitter as nodeEvents.EventEmitter, 'ready'), [1, 2]);
	});

	it('rejects the static once if the emitter errors first', async () => {
		const emitter = new Emitter();

		setTimeout(() => emitter.emit('error', new Error('nope')), 0);

		await assert.rejects(statics.once(emitter as nodeEvents.EventEmitter, 'ready'), /nope/);
	});

	it('reports and sets the listener limit', () => {
		const emitter = new Emitter();

		assert.strictEqual(typeof emitter.getMaxListeners(), 'number');
		assert.strictEqual(emitter.setMaxListeners(5), emitter, 'setMaxListeners is chainable');
		assert.strictEqual(emitter.getMaxListeners(), 5);
	});
});
