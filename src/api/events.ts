/**
 * Events module compatibility layer for Nova extensions
 *
 * Nothing here needs Nova at all: EventEmitter is plain JavaScript, and Node.js
 * only bundles it because it predates modules being commonplace. This is a
 * faithful implementation rather than a mapping, which means the semantics that
 * packages actually rely on - listener order, once() unsubscribing before it
 * calls, an unhandled 'error' throwing - behave as they do in Node.js.
 */

type Listener = (...args: never[]) => void;

interface Wrapped extends Listener {
	listener?: Listener;
}

/** Node.js warns rather than fails once a single event has this many listeners */
let defaultMaxListeners = 10;

export class EventEmitter {
	#events = new Map<string | symbol, Wrapped[]>();
	#maxListeners: number | undefined;

	static defaultMaxListeners = defaultMaxListeners;

	/**
	 * Resolves the next time an emitter emits the named event
	 *
	 * Rejects if the emitter emits 'error' first, which is what makes this safe
	 * to await on something that might fail instead of succeed.
	 */
	static once(emitter: EventEmitter, name: string | symbol): Promise<unknown[]> {
		return new Promise((resolve, reject) => {
			const onError = (error: unknown) => {
				emitter.removeListener(name, onEvent as Listener);
				reject(error);
			};

			const onEvent = (...args: unknown[]) => {
				if (name !== 'error') {
					emitter.removeListener('error', onError as Listener);
				}

				resolve(args);
			};

			emitter.once(name, onEvent as Listener);

			if (name !== 'error') {
				emitter.once('error', onError as Listener);
			}
		});
	}

	static listenerCount(emitter: EventEmitter, name: string | symbol): number {
		return emitter.listenerCount(name);
	}

	#listenersFor(name: string | symbol): Wrapped[] {
		let registered = this.#events.get(name);

		if (!registered) {
			registered = [];
			this.#events.set(name, registered);
		}

		return registered;
	}

	#add(name: string | symbol, listener: Wrapped, prepend: boolean): this {
		// Node.js announces the subscription before recording it
		if (this.#events.has('newListener')) {
			this.emit('newListener', name, listener.listener ?? listener);
		}

		const registered = this.#listenersFor(name);

		if (prepend) {
			registered.unshift(listener);
		} else {
			registered.push(listener);
		}

		const limit = this.#maxListeners ?? EventEmitter.defaultMaxListeners;

		if (limit > 0 && registered.length > limit) {
			console.warn(
				`MaxListenersExceededWarning: Possible EventEmitter memory leak detected. ${registered.length} ${String(name)} listeners added. Use emitter.setMaxListeners() to increase limit`,
			);
		}

		return this;
	}

	on(name: string | symbol, listener: Listener): this {
		return this.#add(name, listener, false);
	}

	addListener(name: string | symbol, listener: Listener): this {
		return this.on(name, listener);
	}

	prependListener(name: string | symbol, listener: Listener): this {
		return this.#add(name, listener, true);
	}

	/**
	 * Wrap a listener so that it unsubscribes before it runs
	 *
	 * Removing first rather than afterwards is what lets a once listener emit the
	 * same event again without recursing forever.
	 */
	#wrapOnce(name: string | symbol, listener: Listener): Wrapped {
		const wrapped: Wrapped = ((...args: never[]) => {
			this.removeListener(name, wrapped);
			(listener as (...args: unknown[]) => void)(...args);
		}) as Wrapped;

		wrapped.listener = listener;

		return wrapped;
	}

	once(name: string | symbol, listener: Listener): this {
		return this.#add(name, this.#wrapOnce(name, listener), false);
	}

	prependOnceListener(name: string | symbol, listener: Listener): this {
		return this.#add(name, this.#wrapOnce(name, listener), true);
	}

	removeListener(name: string | symbol, listener: Listener): this {
		const registered = this.#events.get(name);

		if (!registered) {
			return this;
		}

		// Node.js removes the most recently added match only
		let index = registered.length - 1;

		while (index >= 0) {
			const candidate = registered[index] as Wrapped;

			if (candidate === listener || candidate.listener === listener) {
				break;
			}

			index--;
		}

		if (index === -1) {
			return this;
		}

		registered.splice(index, 1);

		if (registered.length === 0) {
			this.#events.delete(name);
		}

		if (this.#events.has('removeListener')) {
			this.emit('removeListener', name, listener);
		}

		return this;
	}

	off(name: string | symbol, listener: Listener): this {
		return this.removeListener(name, listener);
	}

	removeAllListeners(name?: string | symbol): this {
		if (name === undefined) {
			this.#events.clear();

			return this;
		}

		if (this.#events.has('removeListener')) {
			for (const listener of [...(this.#events.get(name) ?? [])]) {
				this.removeListener(name, listener.listener ?? listener);
			}
		}

		this.#events.delete(name);

		return this;
	}

	/**
	 * Call every listener registered for an event
	 *
	 * An 'error' event with nothing listening throws, which is the behaviour that
	 * turns a silently dropped failure into a visible one.
	 */
	emit(name: string | symbol, ...args: unknown[]): boolean {
		const registered = this.#events.get(name);

		if (!registered || registered.length === 0) {
			if (name === 'error') {
				const [error] = args;

				throw error instanceof Error
					? error
					: Object.assign(new Error(`Unhandled error. (${String(error)})`), { context: error });
			}

			return false;
		}

		// A copy, so that a listener removing another does not skip it
		for (const listener of [...registered]) {
			(listener as (...args: unknown[]) => void).apply(this, args);
		}

		return true;
	}

	listenerCount(name: string | symbol, listener?: Listener): number {
		const registered = this.#events.get(name) ?? [];

		return listener
			? registered.filter((candidate) => candidate === listener || candidate.listener === listener).length
			: registered.length;
	}

	/** The listeners as registered, unwrapping the ones added with once */
	listeners(name: string | symbol): Listener[] {
		return (this.#events.get(name) ?? []).map((listener) => listener.listener ?? listener);
	}

	/** The listeners as stored, with the once wrappers left in place */
	rawListeners(name: string | symbol): Listener[] {
		return [...(this.#events.get(name) ?? [])];
	}

	eventNames(): Array<string | symbol> {
		return [...this.#events.keys()];
	}

	setMaxListeners(count: number): this {
		this.#maxListeners = count;

		return this;
	}

	getMaxListeners(): number {
		return this.#maxListeners ?? EventEmitter.defaultMaxListeners;
	}
}

/**
 * Sets the default listener limit for emitters that have not set their own
 *
 * Node.js exposes this as a mutable property on the module; the class property
 * is the one that is actually read, and this keeps the two in step.
 */
export function setMaxListeners(count: number): void {
	defaultMaxListeners = count;
	EventEmitter.defaultMaxListeners = count;
}

export const once = EventEmitter.once;

export const listenerCount = EventEmitter.listenerCount;

// Node.js exports the class as the module itself, and as three further names
export const EventEmitterAsyncResource = EventEmitter;

Object.assign(EventEmitter, { EventEmitter, default: EventEmitter, once, listenerCount, setMaxListeners });

export default EventEmitter;
