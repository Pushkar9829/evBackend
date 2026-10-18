// Standalone virtual charger that connects to any ChargeX server (local or Render).
// Usage:
//   npm run sim -- --url ws://localhost:4410/ocpp --id VG-PUN-001 --password charger-demo-pass [--protocol ocpp1.6] [--plug]
// Then type commands: plug [n] | unplug [n] | tick | fault [n] | clear [n] | drop [sec] | state | quit
import readline from 'node:readline';
import { VirtualCharger } from '../src/ocpp/simulator.js';

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, all) => {
    if (a.startsWith('--')) acc.push([a.slice(2), all[i + 1] && !all[i + 1].startsWith('--') ? all[i + 1] : true]);
    return acc;
  }, []),
);

const sim = new VirtualCharger({
  url: args.url || 'ws://localhost:4410/ocpp',
  ocppId: args.id || 'VG-PUN-001',
  password: args.password || process.env.SEED_CHARGER_PASSWORD || 'charger-demo-pass',
  protocol: args.protocol || 'ocpp2.0.1',
  connectors: Array.from({ length: Number(args.connectors || 1) }, (_, i) => ({ number: i + 1, maxPowerKw: Number(args.kw || 7.4) })),
  meterIntervalSec: Number(args.interval || 10),
  speed: Number(args.speed || 30),
});
sim.autoReconnectMs = 3000;
sim.listeners.add(({ dir, frame }) => console.log(dir === 'out' ? '→' : '←', JSON.stringify(frame)));

await sim.connect();
console.log(`Connected as ${sim.ocppId} (${sim.protocol}). Commands: plug [n], unplug [n], tick, fault [n], clear [n], drop [sec], state, quit`);
if (args.plug) await sim.plugIn(1);

const rl = readline.createInterface({ input: process.stdin });
rl.on('line', async (line) => {
  const [cmd, a] = line.trim().split(/\s+/);
  const n = Number(a || 1);
  try {
    if (cmd === 'plug') await sim.plugIn(n);
    else if (cmd === 'unplug') await sim.unplug(n);
    else if (cmd === 'tick') await sim.tick();
    else if (cmd === 'fault') await sim.setFault(n, true);
    else if (cmd === 'clear') await sim.setFault(n, false);
    else if (cmd === 'drop') await sim.dropConnection(n * 1000);
    else if (cmd === 'state') console.log(JSON.stringify(sim.state().connectors, null, 2));
    else if (cmd === 'quit') {
      await sim.disconnect();
      process.exit(0);
    } else console.log('unknown command');
  } catch (e) {
    console.error(e.message);
  }
});
