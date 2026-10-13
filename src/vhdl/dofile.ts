import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
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
  variable steps 0
  variable onerror {}
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

# Takes the step's arguments as one list, then pairs of a key and an encoded JSON value to add.
proc ::dofilecheck::emitStep {command arguments args} {
  variable steps
  incr steps
  emit type [json step] command [json $command] args [jsonList $arguments] {*}$args
}

proc ::dofilecheck::record {command args} {
  emitStep $command $args
  return
}

# onerror {resume} lets the do file that sets it, and the files it runs, carry on past an error.
proc ::dofilecheck::onerrorCommand {args} {
  variable onerror
  record onerror {*}$args
  if {[llength $args] > 0} { set onerror [string trim [join $args]] }
  return
}

# Questa ends the run at quit or exit; quit -sim ends only the simulation.
proc ::dofilecheck::quit {command args} {
  record $command {*}$args
  if {"-sim" ni $args} { return -code error -errorcode {DOFILECHECK QUIT} "$command ended the script" }
  return
}

# Asks the runner about a path the script names, from the folder the script is in. Returns its
# answer or raises its error.
proc ::dofilecheck::lookup {operation path} {
  variable cwd
  emit type [json lookup] operation [json $operation] path [json $path] folder [json $cwd]
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

proc ::dofilecheck::pwdCommand {args} {
  variable cwd
  if {[llength $args] != 0} { return -code error {wrong # args: should be "pwd"} }
  return $cwd
}

# cd moves only within the workspace, and its step names the folder it moved to.
proc ::dofilecheck::cdCommand {args} {
  variable cwd
  if {[catch {cdFolder $args} folder options]} {
    record cd {*}$args
    return -options $options $folder
  }
  set cwd $folder
  emitStep cd $args folder [json $folder]
}

proc ::dofilecheck::cdFolder {arguments} {
  if {[llength $arguments] == 0} { return -code error "cd without a folder is not available in a dry run" }
  if {[llength $arguments] > 1} { return -code error {wrong # args: should be "cd ?dirName?"} }
  set path [lindex $arguments 0]
  if {[string match ~* $path]} { return -code error "cd cannot expand ~ in a dry run: $path" }
  return [lookup cd $path]
}

# Resolves an option the way Tcl's glob does, abbreviations included.
proc ::dofilecheck::globOption {argument} {
  set matches {}
  foreach option {-directory -join -nocomplain -path -tails -types --} {
    if {$option eq $argument} { return $option }
    if {[string first $argument $option] == 0} { lappend matches $option }
  }
  if {[llength $matches] == 1} { return [lindex $matches 0] }
  set problem [expr {[llength $matches] == 0 ? "bad" : "ambiguous"}]
  return -code error "$problem option \"$argument\": must be -directory, -nocomplain, -tails, -types, or --"
}

# A leading ~ is refused, as Tcl would read it as a home folder.
proc ::dofilecheck::globParts {path} {
  set parts [::file split $path]
  if {[string match ~* [lindex $parts 0]]} { return -code error "glob cannot expand ~ in a dry run: $path" }
  return $parts
}

proc ::dofilecheck::partsPath {parts} {
  if {[llength $parts] == 0} { return . }
  return [::file join {*}$parts]
}

# The paths after the -directory parts that a pattern's parts can name. A part without wildcards is
# kept as written; a part with them is matched in each folder reached so far, once the runner has
# confirmed that folder is inside the workspace. Tcl leaves the order open; sorted keeps it repeatable.
proc ::dofilecheck::globTails {base parts} {
  variable cwd
  set tails [list {}]
  foreach part $parts {
    set next {}
    foreach tail $tails {
      if {![regexp {[*?\[\]{}\\]} $part]} {
        lappend next [concat $tail [list $part]]
        continue
      }
      set folder [partsPath [concat $base $tail]]
      if {[lookup stat $folder] ne "directory"} continue
      foreach name [lsort [::glob -nocomplain -tails -directory [::file join $cwd $folder] -- $part]] {
        # Joined as it is, a name starting with ~ would read as a home folder.
        if {[string match ~* $name]} { set name ./$name }
        lappend next [concat $tail [list $name]]
      }
    }
    set tails $next
  }
  return $tails
}

# glob over the workspace only. Every match is checked with the runner before it is returned, so a
# pattern that leads outside the workspace is an error, with or without -nocomplain.
proc ::dofilecheck::globCommand {args} {
  set complain 1
  set tails 0
  set types {}
  while {[llength $args] > 0 && [string match -* [lindex $args 0]]} {
    set option [globOption [lindex $args 0]]
    set args [lrange $args 1 end]
    if {$option eq "--"} break
    switch -exact -- $option {
      -nocomplain { set complain 0 }
      -tails { set tails 1 }
      -directory - -types {
        if {[llength $args] == 0} { return -code error "missing argument to \"$option\"" }
        if {$option eq "-directory"} { set base [globParts [lindex $args 0]] } else { set types [lindex $args 0] }
        set args [lrange $args 1 end]
      }
      default { return -code error "glob $option is not available in a dry run" }
    }
  }
  foreach type $types {
    if {$type ni {f d}} { return -code error "glob -types $type is not available in a dry run" }
  }
  if {[llength $args] == 0} { return -code error {wrong # args: should be "glob ?switches? name ?name ...?"} }
  if {$tails && ![info exists base]} { return -code error {"-tails" must be used with "-directory"} }
  if {![info exists base]} { set base {} }

  set matches {}
  foreach pattern $args {
    foreach tail [globTails $base [globParts $pattern]] {
      set path [partsPath [concat $base $tail]]
      set kind [lookup stat $path]
      if {$kind eq "missing" || ([llength $types] > 0 && [dict get {file f directory d other {}} $kind] ni $types)} continue
      lappend matches [expr {$tails ? [partsPath $tail] : $path}]
    }
  }
  if {$complain && [llength $matches] == 0} {
    set noun [expr {[llength $args] == 1 ? "pattern" : "patterns"}]
    return -code error "no files matched glob $noun \"[join $args]\""
  }
  return $matches
}

# do runs a nested script; source does the same for a Tcl file.
proc ::dofilecheck::include {command args} {
  record $command {*}$args
  if {[llength $args] == 0} { return -code error "wrong # args: should be \"$command fileName\"" }
  runFile [lookup source [expr {$command eq "source" ? [lindex $args end] : [lindex $args 0]}]]
}

# Runs one file in the safe interpreter. An onerror the file sets ends with it.
proc ::dofilecheck::runFile {path} {
  variable depth
  variable maxDepth
  variable onerror
  if {$depth >= $maxDepth} { return -code error "do files nest more than $maxDepth deep" }
  set channel [open $path r]
  fconfigure $channel -encoding utf-8
  set script [read $channel]
  close $channel
  set callerOnerror $onerror
  incr depth
  set failed [catch {runCommands $path $script} message options]
  incr depth -1
  set onerror $callerOnerror
  if {$failed} { return -options $options $message }
}

# Runs a script one top-level command at a time, as Questa does, so that onerror {resume} can carry
# on with the next command. Each error is reported with its file, line and the number of steps so far.
# Unless the script resumes, the error is passed up as already reported, so the files that included
# it do not report it again.
proc ::dofilecheck::runCommands {path script} {
  variable interp
  variable onerror
  variable steps
  set lines [split $script \n]
  set command {}
  for {set index 0} {$index < [llength $lines]} {incr index} {
    if {$command eq {}} { set first [expr {$index + 1}] }
    append command [lindex $lines $index] \n
    if {![info complete $command] && $index < [llength $lines] - 1} continue
    set code [$interp eval [list catch $command ::dofilecheck_message ::dofilecheck_options]]
    set command {}
    if {$code == 0} continue
    if {$code != 1} return
    set message [$interp eval {set ::dofilecheck_message}]
    set errorCode [$interp eval {dict get $::dofilecheck_options -errorcode}]
    if {[lindex $errorCode 0] ne "DOFILECHECK"} {
      set line [expr {$first + [$interp eval {dict get $::dofilecheck_options -errorline}] - 1}]
      emit type [json error] file [json $path] line $line message [json $message] step $steps
    } elseif {$errorCode ne {DOFILECHECK REPORTED}} {
      return -code error -errorcode $errorCode $message
    }
    if {$onerror ne "resume"} { return -code error -errorcode {DOFILECHECK REPORTED} $message }
  }
}

proc ::dofilecheck::main {path folder} {
  variable cwd $folder
  variable interp [interp create -safe]
  foreach command {
    vlib vmap vcom vlog vopt vsim vdel vdir
    run step restart force noforce change examine describe find when nowhen bp bd
    add delete wave view noview layout config configure radix property virtual bookmark
    WaveActivateNextPane WaveRestoreCursors WaveRestoreZoom TreeUpdate SetDefaultTree
    log nolog vcd dataset compare mem coverage vcover toggle profile assertion simstats write
    onbreak transcript echo puts
  } {
    interp alias $interp $command {} ::dofilecheck::record $command
  }
  foreach command {quit exit} { interp alias $interp $command {} ::dofilecheck::quit $command }
  foreach command {do source} { interp alias $interp $command {} ::dofilecheck::include $command }
  interp alias $interp onerror {} ::dofilecheck::onerrorCommand
  interp alias $interp cd {} ::dofilecheck::cdCommand
  interp alias $interp file {} ::dofilecheck::pathCommand
  interp alias $interp glob {} ::dofilecheck::globCommand
  interp alias $interp pwd {} ::dofilecheck::pwdCommand
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
::dofilecheck::main [lindex $argv 0] [lindex $argv 1]
`;

export const vhdlStandards = ['87', '93', '2002', '2008', '2019'] as const;
export type VhdlStandard = typeof vhdlStandards[number];

export interface DoFileStep {
  command: string;
  args: string[];
  // The folder a cd moved to.
  folder?: string;
}

export interface DoFileError {
  message: string;
  file?: string;
  line?: number;
  // The number of steps recorded when a Tcl error happened.
  step?: number;
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
  // Resolves a path the script names from the folder the script is in. Throws a RarsError for a path
  // the script may not see.
  locate(path: string, folder: string): Promise<LocatedPath>;
}

export interface DoFileRun {
  steps: DoFileStep[];
  errors: DoFileError[];
}

const messageSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('step'), command: z.string(), args: z.array(z.string()), folder: z.string().optional() }),
  z.object({ type: z.literal('lookup'), operation: z.enum(['source', 'stat', 'cd']), path: z.string(), folder: z.string() }),
  z.object({ type: z.literal('error'), file: z.string(), line: z.number().int(), message: z.string(), step: z.number().int() }),
  z.object({ type: z.literal('done') }),
]);
type Lookup = Extract<z.infer<typeof messageSchema>, { type: 'lookup' }>;

function failure(message: string): string {
  return `error\t${message.replace(/[\r\n]+/g, ' ')}`;
}

// One line on the script's stdin: ok or error, a tab, then the value or message. source answers with
// the file to read, cd with the folder to move to and stat with the kind of path.
async function answer(lookup: Lookup, locate: RunDoFileOptions['locate']): Promise<string> {
  let located: LocatedPath;
  try {
    located = await locate(lookup.path, lookup.folder);
  } catch (error) {
    if (error instanceof RarsError) return failure(error.message);
    throw error;
  }
  if (lookup.operation === 'stat') return `ok\t${located.kind}`;
  if (lookup.operation === 'cd' && located.kind !== 'directory') {
    const problem = located.kind === 'missing' ? 'no such file or directory' : 'not a directory';
    return failure(`couldn't change working directory to "${lookup.path}": ${problem}`);
  }
  if (lookup.operation === 'source' && located.kind === 'missing') return failure(`No such file: ${lookup.path}`);
  if (lookup.operation === 'source' && located.kind !== 'file') return failure(`Not a file: ${lookup.path}`);
  if (/[\r\n]/.test(located.path)) return failure(`Cannot use a path with a line break: ${lookup.path}`);
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
    const child = spawn(options.tclshExecutable, [stubs, options.doFile, options.cwd], { cwd: options.cwd, stdio: ['pipe', 'pipe', 'pipe'] });
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
      if (message.type === 'step') {
        steps.push({ command: message.command, args: message.args, ...(message.folder === undefined ? {} : { folder: message.folder }) });
      } else if (message.type === 'error') {
        errors.push({ file: message.file, line: message.line, message: message.message, step: message.step });
      } else if (message.type === 'done') {
        finished = true;
      } else {
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

interface ParsedArguments<T> {
  flags: string[];
  values: Map<string, string>;
  operands: T[];
}

function parseArguments<T extends { value: string }>(args: readonly T[], valueOptions: ReadonlySet<string>): ParsedArguments<T> {
  const parsed: ParsedArguments<T> = { flags: [], values: new Map(), operands: [] };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (valueOptions.has(arg.value) && index + 1 < args.length) {
      parsed.values.set(arg.value, args[index + 1]!.value);
      index += 1;
    } else if (arg.value.startsWith('-') || arg.value.startsWith('+')) {
      parsed.flags.push(arg.value);
    } else {
      parsed.operands.push(arg);
    }
  }
  return parsed;
}

function operands(args: readonly string[], valueOptions: ReadonlySet<string>): string[] {
  return parseArguments(args.map((value) => ({ value })), valueOptions).operands.map(({ value }) => value);
}

// An argument of a compile command, with the folder a path in it resolves from and the list file that held it.
interface CompileArgument {
  value: string;
  folder: string;
  list?: string;
}

export interface CompileStep {
  file: string;
  // The folder file resolves from.
  folder: string;
  library: string;
  std?: string;
  // The -f or -F list file that named file.
  list?: string;
  order: number;
}

export interface StepAnalysis {
  compiles: CompileStep[];
  libraries: string[];
  simulate?: { top?: string; args: string[] };
  errors: DoFileError[];
}

// A list file's canonical path and text, or why it cannot be read.
export type ListFile = { path: string; text: string } | { error: string };

export interface AnalyzeOptions {
  // The folder the script starts in.
  folder: string;
  // The VHDL standard for vcom calls that name none.
  std?: VhdlStandard;
  // Reads the list file a -f or -F option names, from the folder given.
  readList(path: string, folder: string): Promise<ListFile>;
}

interface Expansion {
  // The folder the command runs in.
  cwd: string;
  // The folder the paths being expanded resolve from.
  base: string;
  list?: string;
  // The canonical paths of the list files being read, outermost first.
  chain: readonly string[];
  readList: AnalyzeOptions['readList'];
  errors: DoFileError[];
}

// Whitespace separates a list file's arguments, and # or // starts a comment that runs to the end of the line.
function listArguments(text: string): string[] {
  return text.split(/\r\n?|\n/).flatMap((line) => line.replace(/(^|\s)(#|\/\/).*$/, '').split(/\s+/).filter((word) => word !== ''));
}

// Replaces each -f or -F option with the arguments in its list file, as if they were written in its place.
// Paths in a -f list resolve from the folder the command runs in, and paths in a -F list from the list's folder.
async function expandLists(args: readonly string[], context: Expansion): Promise<CompileArgument[]> {
  const expanded: CompileArgument[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if ((arg !== '-f' && arg !== '-F') || index + 1 === args.length) {
      expanded.push({ value: arg, folder: context.base, ...(context.list === undefined ? {} : { list: context.list }) });
      continue;
    }
    index += 1;
    const name = args[index]!;
    const list = await context.readList(name, context.base);
    if ('error' in list) {
      context.errors.push({ message: list.error });
    } else if (context.chain.includes(list.path)) {
      context.errors.push({ message: `List file includes itself: ${name}` });
    } else {
      expanded.push(...await expandLists(listArguments(list.text), {
        ...context, base: arg === '-F' ? dirname(list.path) : context.cwd, list: name, chain: [...context.chain, list.path],
      }));
    }
  }
  return expanded;
}

// Reads what the recorded calls compile, from which folder, into which library and with which standard, and
// what they simulate. A cd step moves the folder later paths resolve from.
export async function analyzeSteps(steps: readonly DoFileStep[], options: AnalyzeOptions): Promise<StepAnalysis> {
  const compiles: CompileStep[] = [];
  const libraries = new Set<string>();
  const errors: DoFileError[] = [];
  let folder = options.folder;
  let simulate: StepAnalysis['simulate'];
  for (const step of steps) {
    const { command, args } = step;
    if (command === 'cd' && step.folder !== undefined) {
      folder = step.folder;
    } else if (command === 'vcom' || command === 'vlog') {
      const expanded = await expandLists(args, { cwd: folder, base: folder, chain: [], readList: options.readList, errors });
      const parsed = parseArguments(expanded, compileValueOptions);
      const library = parsed.values.get('-work') ?? 'work';
      const std = command === 'vcom'
        ? parsed.flags.map((flag) => vhdlStandardFlags.get(flag)).filter((standard) => standard !== undefined).at(-1) ?? options.std
        : parsed.flags.includes('-sv') ? 'sv' : undefined;
      for (const { value: file, folder: from, list } of parsed.operands) {
        compiles.push({
          file, folder: from, library, ...(std === undefined ? {} : { std }), ...(list === undefined ? {} : { list }), order: compiles.length + 1,
        });
      }
    } else if (command === 'vlib') {
      for (const library of operands(args, libraryValueOptions)) libraries.add(library);
    } else if (command === 'vsim') {
      const top = operands(args, simulateValueOptions)[0];
      simulate = { ...(top === undefined ? {} : { top }), args };
    }
  }
  return { compiles, libraries: [...libraries], ...(simulate === undefined ? {} : { simulate }), errors };
}
