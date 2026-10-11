/**
 * Reading EPANET's binary output file (as `ws_run_files` returns it, byte for byte
 * as `runepanet` writes it): the network counts, pump energy and the reaction totals
 * the energy and reaction reports show.
 */

export interface PumpEnergy {
  /** Link index in the model's links (0-based). */
  link: number;
  /** Percent of the time on line. */
  utilization: number;
  /** Average efficiency, percent. */
  efficiency: number;
  /** kWh per million gallons (US) or per cubic metre (SI). */
  kwhPerVolume: number;
  averageKw: number;
  peakKw: number;
  /** Cost per day. */
  costPerDay: number;
}

export interface OutFileSummary {
  nodes: number;
  tanks: number;
  links: number;
  pumps: number;
  valves: number;
  periods: number;
  /** EPANET's warning code (0 if none). */
  warning: number;
  energy: PumpEnergy[];
  demandCharge: number;
  /** Average reaction rates over the run, in mass per hour. */
  reactions: { bulk: number; wall: number; tank: number; source: number };
}

const MAGIC = 516114521;

export function readOutFile(bytes: Uint8Array): OutFileSummary {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const i4 = (o: number) => v.getInt32(o, true);
  const r4 = (o: number) => v.getFloat32(o, true);
  if (bytes.byteLength < 88 || i4(0) !== MAGIC || i4(bytes.byteLength - 4) !== MAGIC) {
    throw new Error('not an EPANET output file');
  }
  const [nodes, tanks, links, pumps, valves] = [i4(8), i4(12), i4(16), i4(20), i4(24)];
  const prolog =
    15 * 4 +
    3 * 80 +
    2 * 260 +
    2 * 32 +
    32 * (nodes + links) +
    12 * links +
    8 * tanks +
    4 * nodes +
    8 * links;
  const energy: PumpEnergy[] = [];
  let o = prolog;
  for (let p = 0; p < pumps; p++, o += 28) {
    energy.push({
      link: i4(o) - 1,
      utilization: r4(o + 4),
      efficiency: r4(o + 8),
      kwhPerVolume: r4(o + 12),
      averageKw: r4(o + 16),
      peakKw: r4(o + 20),
      costPerDay: r4(o + 24),
    });
  }
  const demandCharge = r4(o);
  const end = bytes.byteLength;
  return {
    nodes,
    tanks,
    links,
    pumps,
    valves,
    periods: i4(end - 12),
    warning: i4(end - 8),
    energy,
    demandCharge,
    reactions: { bulk: r4(end - 28), wall: r4(end - 24), tank: r4(end - 20), source: r4(end - 16) },
  };
}
