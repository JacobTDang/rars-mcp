import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { z } from 'zod';

import { RarsError } from '../errors.js';

// Runs a Questa or ModelSim .do script in a safe Tcl interpreter, which has no shell, file or
// network access, where each Questa command is a stub that reports its call. Every line on
// stdout is one JSON message; the runner answers each lookup with one line on stdin.
const QUESTA_STUBS = String.raw`
namespace eval ::dofilecheck {
  variable interp {}
  variable depth 0
  variable maxDepth 32
  variable escapes [list \\ \\\\ \" \\\" \n \\n \r \\r \t \\t]
  for {set code 0} {$code < 32} {incr code} {
    set character [format %c $code]
    if {$character ni [list \n \r \t]} { lappend escapes $character [format {\u%04x} $code] }
  }
  unset code character
}

proc ::dofilecheck::json {value} {
  variable escapes
  return "\"[string map $escapes $value]\""
}

proc ::dofilecheck::jsonList {values} {
  set items {}
  foreach value $values { lappend items [json $value] }
  return "\[[join $items ,]\]"
}

# Takes pairs of a key and an already encoded JSON value.
proc ::dofilecheck::emit {args} {
  set fields {}
  foreach {key value} $args { lappend fields "[json $key]:$value" }
  puts stdout "\{[join $fields ,]\}"
}

proc ::dofilecheck::record {command args} {
  emit type [json step] command [json $command] args [jsonList $args]
  return
}

# Questa ends the run at quit or exit; quit -sim ends only the simulation.
proc ::dofilecheck::quit {command args} {
  record $command {*}$args
  if {"-sim" ni $args} { return -code error -errorcode {DOFILECHECK QUIT} "$command ended the script" }
  return
}

# Asks the runner about a path the script names. Returns its answer or raises its error.
proc ::dofilecheck::lookup {operation path} {
  emit type [json lookup] operation [json $operation] path [json $path]
  if {[gets stdin answer] < 0} {
    return -code error -errorcode {DOFILECHECK FATAL} "The runner stopped answering lookups"
  }
  set separator [string first \t $answer]
  set value [string range $answer [expr {$separator + 1}] end]
  if {[string range $answer 0 [expr {$separator - 1}]] ne "ok"} { return -code error $value }
  return $value
}

# The path subcommands of file, with existence answered from the workspace.
proc ::dofilecheck::pathCommand {subcommand args} {
  switch -exact -- $subcommand {
    dirname - extension - join - rootname - split - tail {
      return [::file $subcommand {*}$args]
    }
    exists - isdirectory - isfile {
      if {[llength $args] != 1} { return -code error "wrong # args: should be \"file $subcommand name\"" }
      set kind [lookup stat [lindex $args 0]]
      switch -exact -- $subcommand {
        exists { return [expr {$kind ne "missing"}] }
        isdirectory { return [expr {$kind eq "directory"}] }
        isfile { return [expr {$kind eq "file"}] }
      }
    }
    default { return -code error "file $subcommand is not available in a dry run" }
  }
}

# do runs a nested script; source does the same for a Tcl file.
proc ::dofilecheck::include {command args} {
  record $command {*}$args
  if {[llength $args] == 0} { return -code error "wrong # args: should be \"$command fileName\"" }
  runFile [lookup source [expr {$command eq "source" ? [lindex $args end] : [lindex $args 0]}]]
}

# Runs one file in the safe interpreter. Its first error is reported with its own file and line,
# then passed up as already reported so the files that included it do not report it again.
proc ::dofilecheck::runFile {path} {
  variable interp
  variable depth
  variable maxDepth
  if {$depth >= $maxDepth} { return -code error "do files nest more than $maxDepth deep" }
  set channel [open $path r]
  fconfigure $channel -encoding utf-8
  set script [read $channel]
  close $channel
  incr depth
  set code [$interp eval [list catch $script ::dofilecheck_message ::dofilecheck_options]]
  incr depth -1
  if {$code != 1} { return }
  set message [$interp eval {set ::dofilecheck_message}]
  set errorCode [$interp eval {dict get $::dofilecheck_options -errorcode}]
  if {[lindex $errorCode 0] ne "DOFILECHECK"} {
    set line [$interp eval {dict get $::dofilecheck_options -errorline}]
    emit type [json error] file [json $path] line $line message [json $message]
    set errorCode {DOFILECHECK REPORTED}
  }
  return -code error -errorcode $errorCode $message
}

proc ::dofilecheck::main {path} {
  variable interp [interp create -safe]
  foreach command {
    vlib vmap vcom vlog vopt vsim vdel run add wave view config configure radix force noforce restart
    onbreak onerror transcript echo log puts
  } {
    interp alias $interp $command {} ::dofilecheck::record $command
  }
  foreach command {quit exit} { interp alias $interp $command {} ::dofilecheck::quit $command }
  foreach command {do source} { interp alias $interp $command {} ::dofilecheck::include $command }
  interp alias $interp file {} ::dofilecheck::pathCommand
  $interp eval {proc quietly {args} { uplevel 1 $args }}
  if {[catch {runFile $path} message options]} {
    set errorCode [dict get $options -errorcode]
    if {$errorCode ne {DOFILECHECK QUIT} && $errorCode ne {DOFILECHECK REPORTED}} {
      return -options $options $message
    }
  }
  emit type [json done]
}

fconfigure stdout -encoding utf-8 -translation lf -buffering line
fconfigure stdin -encoding utf-8 -translation lf
::dofilecheck::main [lindex $argv 0]
`;

export const vhdlStandards = ['87', '93', '2002', '2008', '2019'] as const;
export type VhdlStandard = typeof vhdlStandards[number];

export interface DoFileStep {
  command: string;
  args: string[];
}

export interface DoFileError {
  message: string;
  file?: string;
  line?: number;
}

export type PathKind = 'file' | 'directory' | 'other' | 'missing';

export interface LocatedPath {
  path: string;
  kind: PathKind;
}

export interface RunDoFileOptions {
  tclshExecutable: string;
  doFile: string;
  cwd: string;
  timeoutMs: number;
  maxOutputBytes: number;
  // Resolves a path the script names. Throws a RarsError for a path the script may not see.
  locate(path: string): Promise<LocatedPath>;
}

export interface DoFileRun {
  steps: DoFileStep[];
  errors: DoFileError[];
}

const messageSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('step'), command: z.string(), args: z.array(z.string()) }),
  z.object({ type: z.literal('lookup'), operation: z.enum(['source', 'stat']), path: z.string() }),
  z.object({ type: z.literal('error'), file: z.string(), line: z.number().int(), message: z.string() }),
  z.object({ type: z.literal('done') }),
]);
type Lookup = Extract<z.infer<typeof messageSchema>, { type: 'lookup' }>;

// One line on the script's stdin: ok or error, a tab, then the value or message.
async function answer(lookup: Lookup, locate: RunDoFileOptions['locate']): Promise<string> {
  let located: LocatedPath;
  try {
    located = await locate(lookup.path);
  } catch (error) {
    if (error instanceof RarsError) return `error\t${error.message.replace(/[\r\n]+/g, ' ')}`;
    throw error;
  }
  if (lookup.operation === 'stat') return `ok\t${located.kind}`;
  if (located.kind === 'missing') return `error\tNo such file: ${lookup.path}`;
  if (located.kind !== 'file') return `error\tNot a file: ${lookup.path}`;
  if (/[\r\n]/.test(located.path)) return `error\tCannot read a path with a line break: ${lookup.path}`;
  return `ok\t${located.path}`;
}

export async function runDoFile(options: RunDoFileOptions): Promise<DoFileRun> {
  const directory = await mkdtemp(join(tmpdir(), 'rars-dofile-'));
  try {
    const stubs = join(directory, 'questa-stubs.tcl');
    await writeFile(stubs, QUESTA_STUBS);
    return await runStubs(options, stubs);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function runStubs(options: RunDoFileOptions, stubs: string): Promise<DoFileRun> {
  return new Promise((resolve, reject) => {
    const child = spawn(options.tclshExecutable, [stubs, options.doFile], { cwd: options.cwd, stdio: ['pipe', 'pipe', 'pipe'] });
    const steps: DoFileStep[] = [];
    const errors: DoFileError[] = [];
    const decoder = new StringDecoder('utf8');
    let partialLine = '';
    let stderr = '';
    let capturedBytes = 0;
    let timedOut = false;
    let truncated = false;
    let finished = false;
    let failure: Error | undefined;
    let stdinError: Error | undefined;
    let lookups = Promise.resolve();

    const stop = (error: Error) => {
      failure ??= error;
      child.kill('SIGKILL');
    };
    const capture = (chunk: Buffer): Buffer => {
      const remaining = Math.max(options.maxOutputBytes - capturedBytes, 0);
      if (chunk.length > remaining) {
        truncated = true;
        child.kill('SIGKILL');
      }
      capturedBytes += Math.min(chunk.length, remaining);
      return chunk.subarray(0, remaining);
    };
    const handle = (line: string) => {
      let message: z.infer<typeof messageSchema>;
      try {
        message = messageSchema.parse(JSON.parse(line));
      } catch {
        stop(new Error(`Unexpected output from ${options.tclshExecutable}: ${line}`));
        return;
      }
      if (message.type === 'step') steps.push({ command: message.command, args: message.args });
      else if (message.type === 'error') errors.push({ file: message.file, line: message.line, message: message.message });
      else if (message.type === 'done') finished = true;
      else {
        lookups = lookups
          .then(() => answer(message, options.locate))
          .then((reply) => { child.stdin.write(`${reply}\n`); }, stop);
      }
    };

    child.stdout.on('data', (chunk: Buffer) => {
      if (truncated || failure !== undefined) return;
      const lines = (partialLine + decoder.write(capture(chunk))).split('\n');
      partialLine = lines.pop()!;
      for (const line of lines) handle(line);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += capture(chunk).toString('utf8');
    });
    // A write fails only once the script has gone; the close handler reports why it went.
    child.stdin.on('error', (error) => {
      stdinError ??= error;
    });
    child.once('error', (error) => {
      clearTimeout(timeout);
      reject(new Error(`Cannot run the Tcl shell ${options.tclshExecutable}; set TCLSH to its path (${error.message})`));
    });

    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, options.timeoutMs);

    child.once('close', (exitCode, signal) => {
      clearTimeout(timeout);
      void lookups.then(() => {
        if (failure !== undefined) {
          reject(failure);
        } else if (timedOut) {
          resolve({ steps, errors: [...errors, { message: `The check did not finish within ${options.timeoutMs} ms` }] });
        } else if (truncated) {
          resolve({ steps, errors: [...errors, { message: `The check exceeded its ${options.maxOutputBytes}-byte output limit` }] });
        } else if (!finished || exitCode !== 0 || partialLine !== '') {
          reject(new Error(`${options.tclshExecutable} stopped before finishing the check `
            + `(exit ${exitCode ?? signal}): ${stderr.trim() || partialLine}`));
        } else if (stdinError !== undefined) {
          reject(stdinError);
        } else {
          resolve({ steps, errors });
        }
      });
    });
  });
}

const vhdlStandardFlags = new Map<string, VhdlStandard>(vhdlStandards.map((standard) => [`-${standard}`, standard]));

// Options that take the next argument as their value, so it is not read as a file or design unit.
const compileValueOptions = new Set([
  '-work', '-f', '-F', '-modelsimini', '-error', '-warning', '-note', '-suppress', '-fatal', '-msgmode', '-l',
  '-logfile', '-outf', '-just', '-skip', '-nowarn', '-pslfile', '-cover', '-coveropt', '-L', '-Lf', '-y', '-v',
  '-timescale', '-dpiheader', '-ccflags',
]);
const simulateValueOptions = new Set([
  '-t', '-L', '-Lf', '-lib', '-do', '-wlf', '-l', '-logfile', '-modelsimini', '-sv_lib', '-sv_root', '-sv_liblist',
  '-pli', '-onfinish', '-title', '-view', '-msgmode', '-suppress', '-error', '-warning', '-note', '-fatal', '-sdfmin',
  '-sdftyp', '-sdfmax', '-f',
]);
const libraryValueOptions = new Set(['-type', '-dirpath', '-format']);

interface ParsedArguments {
  flags: string[];
  values: Map<string, string>;
  operands: string[];
}

function parseArguments(args: string[], valueOptions: ReadonlySet<string>): ParsedArguments {
  const parsed: ParsedArguments = { flags: [], values: new Map(), operands: [] };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (valueOptions.has(arg) && index + 1 < args.length) {
      parsed.values.set(arg, args[index + 1]!);
      index += 1;
    } else if (arg.startsWith('-') || arg.startsWith('+')) {
      parsed.flags.push(arg);
    } else {
      parsed.operands.push(arg);
    }
  }
  return parsed;
}

export interface CompileStep {
  file: string;
  library: string;
  std?: string;
  order: number;
}

export interface StepAnalysis {
  compiles: CompileStep[];
  libraries: string[];
  simulate?: { top?: string; args: string[] };
}

// Reads what the recorded calls compile, into which library and with which standard, and what they simulate.
export function analyzeSteps(steps: readonly DoFileStep[], defaultStd?: VhdlStandard): StepAnalysis {
  const compiles: CompileStep[] = [];
  const libraries = new Set<string>();
  let simulate: StepAnalysis['simulate'];
  for (const { command, args } of steps) {
    if (command === 'vcom' || command === 'vlog') {
      const parsed = parseArguments(args, compileValueOptions);
      const library = parsed.values.get('-work') ?? 'work';
      const std = command === 'vcom'
        ? parsed.flags.map((flag) => vhdlStandardFlags.get(flag)).filter((standard) => standard !== undefined).at(-1) ?? defaultStd
        : parsed.flags.includes('-sv') ? 'sv' : undefined;
      for (const file of parsed.operands) {
        compiles.push({ file, library, ...(std === undefined ? {} : { std }), order: compiles.length + 1 });
      }
    } else if (command === 'vlib') {
      for (const library of parseArguments(args, libraryValueOptions).operands) libraries.add(library);
    } else if (command === 'vsim') {
      const top = parseArguments(args, simulateValueOptions).operands[0];
      simulate = { ...(top === undefined ? {} : { top }), args };
    }
  }
  return { compiles, libraries: [...libraries], ...(simulate === undefined ? {} : { simulate }) };
}
