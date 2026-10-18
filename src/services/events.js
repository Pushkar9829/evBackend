import { EventEmitter } from 'node:events';

// In-process event bus. Session/charger changes are published here and fanned out to
// live clients (SSE) and to roaming push. With several nodes this becomes Redis pub/sub.
export const events = new EventEmitter();
events.setMaxListeners(1000);
