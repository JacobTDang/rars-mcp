import type { VhdlDiagnostic, VhdlMessage } from './simulator.js';

// nvc --messages=compact prints one line per message: "file:line:column: severity: text",
// or "severity: text" when the message has no source location.
const ENTRY = /^(?:(.+?):(\d+):(\d+): )?(note|warning|error|failure|fatal): (.*)$/;
// Messages raised while simulating start with the time and delta cycle, such as "20ns+1: ".
const SIMULATION_TIME = /^(\d+[a-z]+)\+\d+: ([\s\S]*)$/;
const ELABORATION = /^\(init\): /;
const UNBOUND = /^cannot find entity for component (\S+) without binding indication$/;

interface Entry {
  location?: { file: string; line: number; column: number };
  severity: VhdlMessage['severity'];
  text: string;
}

function diagnosticSeverity(severity: Entry['severity']): VhdlDiagnostic['severity'] {
  return severity === 'warning' || severity === 'note' ? severity : 'error';
}

// An unbound component elaborates to nothing, so a testbench around it can pass without testing anything.
function explain(text: string): string {
  const unbound = UNBOUND.exec(text);
  if (unbound === null) return text;
  return `component ${unbound[1]} is unbound: nvc found no entity for it, so its instances do nothing `
    + 'and the testbench may silently pass';
}

export function parseNvcOutput(output: string): { diagnostics: VhdlDiagnostic[]; messages: VhdlMessage[] } {
  const entries: Entry[] = [];
  for (const line of output.replace(/\r?\n$/, '').split(/\r?\n/)) {
    const match = ENTRY.exec(line);
    if (match !== null) {
      entries.push({
        ...(match[1] === undefined ? {} : { location: { file: match[1], line: Number(match[2]), column: Number(match[3]) } }),
        severity: match[4] as Entry['severity'],
        text: match[5]!,
      });
    } else if (entries.length > 0) {
      // A report string with line breaks continues on the following lines.
      entries[entries.length - 1]!.text += `\n${line}`;
    }
  }

  const diagnostics: VhdlDiagnostic[] = [];
  const messages: VhdlMessage[] = [];
  for (const { location, severity, text } of entries) {
    const simulation = SIMULATION_TIME.exec(text);
    if (simulation !== null) {
      messages.push({ time: simulation[1]!, severity, text: simulation[2]!, ...(location === undefined ? {} : { source: location }) });
    } else {
      diagnostics.push({
        severity: diagnosticSeverity(severity),
        ...location,
        message: explain(text.replace(ELABORATION, '')),
      });
    }
  }
  return { diagnostics, messages };
}
