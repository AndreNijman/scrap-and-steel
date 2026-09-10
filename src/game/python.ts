// SCRAP & STEEL — game/python.ts
// A small Python dialect for robot logic. Compiles to a JS function that runs
// each sim tick. Supported: assignments, if/elif/else, comparisons, arithmetic,
// and/or/not, calls into the robot API. No loops or imports — a tick-driven
// program must not spin.

export interface PythonApi {
  forward: () => number;
  back: () => number;
  fire: () => number;
  aux: () => number;
  turret: () => number;
  /** live sensor reading by part id (radar ids: "<part>#bearing" / "#range") */
  sensor: (partId: string) => number;
  /** drive a motor: -1 .. +1 of rated torque */
  motor: (partId: string, value: number) => void;
  /** aim a servo / extend a piston: degrees */
  servo: (partId: string, degrees: number) => void;
  /** fire a weapon while the value is non-zero */
  weapon: (partId: string, value: number) => void;
  /** hold the machine in place while non-zero */
  brake: (value: number) => void;
  clamp: (v: number, lo: number, hi: number) => number;
  abs: (v: number) => number;
  min: (...vs: number[]) => number;
  max: (...vs: number[]) => number;
  /** stateful PID: returns the control output */
  pid: (key: string, target: number, value: number, kp: number, ki: number, kd: number) => number;
  /** persistent storage across ticks */
  remember: (key: string, value: number) => void;
  recall: (key: string, fallback: number) => number;
}

export interface PythonCompileResult {
  ok: boolean;
  error?: string;
  fn?: (api: PythonApi) => void;
}

interface PyLine {
  indent: number;
  text: string;
}

const BUILTINS = new Set(["forward", "back", "fire", "aux", "turret", "sensor", "motor", "servo", "weapon", "brake", "clamp", "abs", "min", "max", "pid", "remember", "recall"]);

export const PYTHON_DOCS = [
  "INPUTS      forward() back() fire() aux() turret()",
  "            sensor(\"part id\")  — live reading",
  "OUTPUTS     motor(\"id\", -1..1)  servo(\"id\", deg)",
  "            weapon(\"id\", v)  brake(v)",
  "HELPERS     clamp(v, lo, hi)  abs(v)  min(...)  max(...)",
  "            pid(\"key\", target, value, kp, ki, kd)",
  "            remember(\"key\", v)  recall(\"key\", default)",
  "EXAMPLE     drive = forward() - back()",
  "            motor(\"m1\", clamp(drive, -1, 1))",
].join("\n");

function stripComments(line: string): string {
  let out = "";
  let inStr = false;
  let strCh = "";
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inStr) {
      out += ch;
      if (ch === strCh) inStr = false;
      continue;
    }
    if (ch === "\"" || ch === "'") {
      inStr = true;
      strCh = ch;
      out += ch;
      continue;
    }
    if (ch === "#") break;
    out += ch;
  }
  return out;
}

function transformIdentifiers(js: string, knownVars: Set<string>): string {
  js = js.replace(/\bTrue\b/g, "true").replace(/\bFalse\b/g, "false").replace(/\bNone\b/g, "null");
  js = js.replace(/\band\b/g, "&&").replace(/\bor\b/g, "||").replace(/\bnot\b/g, "!");
  js = js.replace(/\bif\b/g, "?").replace(/\belse\b/g, ":"); // python ternary
  for (const b of BUILTINS) {
    js = js.replace(new RegExp(`\\b${b}\\s*\\(`, "g"), `__api.${b}(`);
  }
  js = js.replace(/\b([a-zA-Z_]\w*)\b(?!\s*\()/g, (m) => {
    if (knownVars.has(m) || ["true", "false", "null", "api"].includes(m) || m.startsWith("__")) return m;
    throw new CompileError(`unknown name "${m}"`);
  });
  return js;
}

/** Transform a python expression to JS. String literals pass through untouched. */
function transpileExpr(expr: string, knownVars: Set<string>): string {
  const parts = expr.split(/("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')/);
  return parts.map((part, i) => (i % 2 === 1 ? part : transformIdentifiers(part, knownVars))).join("");
}

class CompileError extends Error {}

/** Transpile a constrained python program to a JS function body. */
export function compilePython(source: string): PythonCompileResult {
  try {
    const lines: PyLine[] = [];
    for (const raw of source.split("\n")) {
      const noComment = stripComments(raw);
      if (!noComment.trim()) continue;
      const indent = noComment.length - noComment.trimStart().length;
      lines.push({ indent, text: noComment.trim() });
    }
    const knownVars = new Set<string>();
    const declared = new Set<string>();
    const out: string[] = [];
    const emitStatements = (startIdx: number, parentIndent: number): number => {
      let i = startIdx;
      if (parentIndent >= 0) {
        if (i >= lines.length || lines[i]!.indent <= parentIndent) {
          throw new CompileError(`expected an indented block at line ${i < lines.length ? i + 1 : i}`);
        }
      }
      const blockIndent = parentIndent >= 0 ? lines[i]!.indent : 0;
      while (i < lines.length) {
        const line = lines[i]!;
        if (line.indent < blockIndent) break;
        if (line.indent > blockIndent) throw new CompileError(`unexpected indent at line ${i + 1}`);
        const text = line.text;

        // if statement starts a chain
        const ifM = text.match(/^if\s+(.+):$/);
        if (ifM) {
          out.push(`if (${transpileExpr(ifM[1]!, knownVars)}) {`);
          i = emitStatements(i + 1, blockIndent);
          out.push("}");
          // check for following elif / else at the same blockIndent
          while (i < lines.length && lines[i]!.indent === blockIndent) {
            const nextText = lines[i]!.text;
            const elifM = nextText.match(/^elif\s+(.+):$/);
            const elseM = nextText.match(/^else:$/);
            if (elifM) {
              out.push(`else if (${transpileExpr(elifM[1]!, knownVars)}) {`);
              i = emitStatements(i + 1, blockIndent);
              out.push("}");
              continue;
            }
            if (elseM) {
              out.push("else {");
              i = emitStatements(i + 1, blockIndent);
              out.push("}");
              break;
            }
            break;
          }
          continue;
        }

        const elifM = text.match(/^elif\s+(.+):$/);
        const elseM = text.match(/^else:$/);
        if (elifM || elseM) {
          throw new CompileError(`unexpected ${elifM ? "elif" : "else"} without matching if at line ${i + 1}`);
        }

        // assignment
        const assign = text.match(/^([a-zA-Z_]\w*)\s*=\s*(.+)$/);
        if (assign) {
          const name = assign[1]!;
          if (BUILTINS.has(name)) throw new CompileError(`"${name}" is a built-in name`);
          const kw = declared.has(name) ? "" : "let ";
          declared.add(name);
          knownVars.add(name);
          out.push(`${kw}${name} = ${transpileExpr(assign[2]!, knownVars)};`);
          i++;
          continue;
        }

        // bare call
        if (/^[a-zA-Z_]\w*\(.*\)$/.test(text) || BUILTINS.has(text.replace(/\(.*/, ""))) {
          out.push(`${transpileExpr(text, knownVars)};`);
          i++;
          continue;
        }

        throw new CompileError(`cannot parse: ${text}`);
      }
      return i;
    };

    emitStatements(0, -1);
    const body = out.join("\n");
    // eslint-disable-next-line no-new-func
    const fn = new Function("__api", `"use strict";\nconst api = __api;\n${body}\n`) as (api: PythonApi) => void;
    // smoke run with a stub api to catch immediate errors
    fn(stubApi());
    return { ok: true, fn };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

function stubApi(): PythonApi {
  const noop = () => 0;
  return {
    forward: () => 0, back: () => 0, fire: () => 0, aux: () => 0, turret: () => 0,
    sensor: () => 0,
    motor: noop, servo: noop, weapon: noop, brake: noop,
    clamp: (v) => v, abs: Math.abs, min: Math.min, max: Math.max,
    pid: () => 0, remember: noop, recall: () => 0,
  };
}

/** Generate readable python from a node graph (one-way convert). */
export function nodesToPython(nodes: { id: string; type: string; params: Record<string, string | number>; in: Record<string, string | null> }[]): string {
  // topological-ish: keep insertion order, inputs referenced by var name
  const varName = new Map<string, string>();
  const counters = new Map<string, number>();
  const nameFor = (n: { type: string }) => {
    const base = n.type.replace(/_/g, "_");
    const c = (counters.get(base) ?? 0) + 1;
    counters.set(base, c);
    return c === 1 ? base : `${base}${c}`;
  };
  const out: string[] = [];
  for (const n of nodes) {
    const v = nameFor(n);
    varName.set(n.id, v);
    const inVal = (port: string) => {
      const src = n.in[port];
      return src ? (varName.get(src) ?? "0") : "0";
    };
    const partArg = (label: string) => {
      const pid = String(n.params.part ?? "");
      return pid ? `"${pid}"` : `"PUT_${label}_ID_HERE"`;
    };
    switch (n.type) {
      case "key_forward": out.push(`${v} = forward()`); break;
      case "key_back": out.push(`${v} = back()`); break;
      case "key_fire": out.push(`${v} = fire()`); break;
      case "key_aux": out.push(`${v} = aux()`); break;
      case "key_turret": out.push(`${v} = turret()`); break;
      case "sensor_value": out.push(`${v} = sensor("${String(n.params.part ?? "")}")`); break;
      case "constant": out.push(`${v} = ${Number(n.params.value ?? 0)}`); break;
      case "and": out.push(`${v} = 1 if (${inVal("a")} != 0 and ${inVal("b")} != 0) else 0`); break;
      case "or": out.push(`${v} = 1 if (${inVal("a")} != 0 or ${inVal("b")} != 0) else 0`); break;
      case "not": out.push(`${v} = 0 if ${inVal("a")} != 0 else 1`); break;
      case "xor": out.push(`${v} = 1 if (${inVal("a")} != 0) != (${inVal("b")} != 0) else 0`); break;
      case "gt": out.push(`${v} = 1 if ${inVal("a")} > ${inVal("b")} else 0`); break;
      case "lt": out.push(`${v} = 1 if ${inVal("a")} < ${inVal("b")} else 0`); break;
      case "eq": out.push(`${v} = 1 if abs(${inVal("a")} - ${inVal("b")}) < 0.001 else 0`); break;
      case "add": out.push(`${v} = ${inVal("a")} + ${inVal("b")}`); break;
      case "sub": out.push(`${v} = ${inVal("a")} - ${inVal("b")}`); break;
      case "mul": out.push(`${v} = ${inVal("a")} * ${inVal("b")}`); break;
      case "div": out.push(`${v} = ${inVal("a")} / max(${inVal("b")}, 0.0001)`); break;
      case "abs": out.push(`${v} = abs(${inVal("a")})`); break;
      case "clamp": out.push(`${v} = clamp(${inVal("a")}, ${Number(n.params.min ?? 0)}, ${Number(n.params.max ?? 1)})`); break;
      case "select": out.push(`${v} = ${inVal("a")} if ${inVal("cond")} != 0 else ${inVal("b")}`); break;
      case "timer": out.push(`${v} = pid("timer_${n.id.slice(-4)}", 0, 0, 0, 0, 0)`); break; // timers are node-only; use remember/counters
      case "pid": out.push(`${v} = pid("pid_${n.id.slice(-4)}", ${inVal("target")}, ${inVal("a")}, ${Number(n.params.kp ?? 2)}, ${Number(n.params.ki ?? 0.2)}, ${Number(n.params.kd ?? 0.4)})`); break;
      case "motor_power": out.push(`motor(${partArg("MOTOR")}, max(-1, min(1, ${inVal("val")})))`); break;
      case "servo_target": out.push(`servo(${partArg("SERVO")}, ${inVal("val")})`); break;
      case "weapon_fire": out.push(`weapon(${partArg("WEAPON")}, ${inVal("val")})`); break;
      case "brake": out.push(`brake(${inVal("val")})`); break;
      case "toggle": case "latch": case "delay": case "counter":
        out.push(`${v} = recall("${n.type}_${n.id.slice(-4)}", 0)  # node-only behaviour`);
        break;
      default: break;
    }
  }
  return out.join("\n") || "# no logic nodes to convert";
}
