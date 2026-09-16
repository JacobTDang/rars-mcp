export interface Diagnostic {
  severity: 'error' | 'warning';
  file?: string;
  line?: number;
  column?: number;
  message: string;
}

const SOURCE_DIAGNOSTIC = /^(Error|Warning) in (.+?) line (\d+)(?: column (\d+))?: (.+)$/;

export function parseDiagnostics(output: string): Diagnostic[] {
  return output
    .split(/\r?\n/)
    .map((line) => line.match(SOURCE_DIAGNOSTIC))
    .filter((match): match is RegExpMatchArray => match !== null)
    .map((match) => ({
      severity: match[1]!.toLowerCase() as Diagnostic['severity'],
      file: match[2]!,
      line: Number(match[3]),
      ...(match[4] === undefined ? {} : { column: Number(match[4]) }),
      message: match[5]!,
    }));
}
