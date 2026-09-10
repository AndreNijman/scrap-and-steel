# Logic Circuits and Python Programming Guide

Scrap & Steel provides two execution modes for robot control logic:
visual node circuits and Python scripts. Both modes run at fixed 60 Hz on the client.

## Simulation Execution Model

1. **Fixed 60 Hz Tick:** Logic programs run once per simulation step.
2. **Tick Budget:** Logic must complete within the frame deadline. The engine rejects
   unbounded loops and external network calls.
3. **Immutability:** Runtime values (heat, damage, battery charge, velocity)
   do not alter blueprint files. Restoring test mode rebuilds the
   simulation from the initial blueprint snapshot.
4. **Resilience:** Faulty programs or missing components zero out actuator
   commands. A logic error stops motion without crashing physics.

---

## Python Scripting Dialect

Switch to Python mode using the **NODES / PYTHON** toggle in the LOGIC CIRCUIT
header. In Python mode, the script executes each tick instead of the node graph.

### Built-in Robot API

Functions available in global scope:

| Function | Signature | Return Type | Description |
|---|---|---|---|
| `forward` | `forward()` | `float` | Returns 1.0 while holding W (forward key), else 0.0. |
| `back` | `back()` | `float` | Returns 1.0 while holding S (reverse key), else 0.0. |
| `fire` | `fire()` | `float` | Returns 1.0 while holding Space (trigger key), else 0.0. |
| `aux` | `aux()` | `float` | Returns 1.0 while holding Shift (aux key), else 0.0. |
| `turret` | `turret()` | `float` | Returns -1.0 (Q / CCW) to +1.0 (E / CW) turn axis. |
| `sensor` | `sensor(part_id)` | `float` | Reads value from a wired sensor part. Accepts full ID or 4-character suffix. |
| `motor` | `motor(part_id, value)` | `void` | Commands motor torque from -1.0 (reverse) to +1.0 (forward). |
| `servo` | `servo(part_id, degrees)` | `void` | Sets target angle (-90 to +90 degrees) or piston stroke (0 to 1). |
| `weapon` | `weapon(part_id, value)` | `void` | Non-zero value triggers firing when power and ammo exist. |
| `brake` | `brake(value)` | `void` | Non-zero value locks all driven wheels. |
| `clamp` | `clamp(value, min, max)` | `float` | Restricts numeric value to `[min, max]`. |
| `abs` | `abs(value)` | `float` | Returns absolute value. |
| `min` | `min(*values)` | `float` | Returns lowest numeric argument. |
| `max` | `max(*values)` | `float` | Returns highest numeric argument. |
| `pid` | `pid(key, target, val, kp, ki, kd)` | `float` | Computes a stateful PID controller across simulation ticks. |
| `remember` | `remember(key, value)` | `void` | Stores numeric state for key across ticks. |
| `recall` | `recall(key, fallback)` | `float` | Reads stored state for key, returning fallback if unset. |

### Component Identifiers

Each placed part has an identifier (for example: `p4f2a`).
Click a part in the workshop to display its ID in the COMPONENT panel.
Clicking the ID copies it to the clipboard.

The Python API accepts either the full identifier (`"p4f2a"`) or the 4-character
suffix (`"4f2a"`).

#### Sensor Suffixes

Radars provide directional and distance channels via `#bearing` and `#range`:

```python
angle = sensor("cam1#bearing")  # Relative bearing to enemy in degrees (-180 to 180)
distance = sensor("cam1#range")  # Distance to enemy in meters
```

### Supported Syntax

The compiler supports a deterministic subset of Python:

- Variable assignments: `speed = forward() - back()`
- Conditionals: `if`, `elif`, `else`
- Ternary expressions: `power = 1.0 if fire() else 0.0`
- Comparisons: `==`, `!=`, `<`, `<=`, `>`, `>=`
- Boolean operators: `and`, `or`, `not`
- Arithmetic: `+`, `-`, `*`, `/`
- Comments starting with `#`

The compiler rejects loops (`for`, `while`), classes, custom functions, and `import`
statements.

---

## Visual Node Reference

Nodes form a directed dataflow graph evaluated each 60 Hz tick.

### Input Nodes

| Type | Name | Ports | Description |
|---|---|---|---|
| `key_forward` | INPUT FORWARD | Out: `val` | 1 while forward key held, else 0. |
| `key_back` | INPUT REVERSE | Out: `val` | 1 while reverse key held, else 0. |
| `key_fire` | INPUT TRIGGER | Out: `val` | 1 while fire key held, else 0. |
| `key_aux` | INPUT AUX | Out: `val` | 1 while aux key held, else 0. |
| `key_turret` | INPUT TURRET | Out: `val` | Turn axis -1 (CCW) to +1 (CW). |
| `sensor_value` | SENSOR | Out: `val` | Numeric value from wired sensor part. |
| `constant` | CONSTANT | Out: `val` | Static floating-point number. |

### Math & Logic Nodes

| Type | Name | Ports | Description |
|---|---|---|---|
| `add` | ADD | In: `a`, `b` / Out: `val` | Sum of inputs `a + b`. |
| `sub` | SUBTRACT | In: `a`, `b` / Out: `val` | Difference `a - b`. Standard for tank drive: `forward - reverse`. |
| `mul` | MULTIPLY | In: `a`, `b` / Out: `val` | Product `a * b`. |
| `div` | DIVIDE | In: `a`, `b` / Out: `val` | Quotient `a / b` (returns 0 if `b == 0`). |
| `abs` | ABSOLUTE | In: `a` / Out: `val` | Magnitude `\|a\|`. |
| `clamp` | CLAMP | In: `a` / Out: `val` | Clamps input `a` between configurable min and max bounds. |
| `gt` / `lt` / `eq` | GREATER / LESS / EQUAL | In: `a`, `b` / Out: `val` | Numeric comparisons producing 1 or 0. |
| `and` / `or` / `xor` | AND / OR / XOR | In: `a`, `b` / Out: `val` | Boolean logic gates. |
| `not` | NOT | In: `a` / Out: `val` | Inverts non-zero to 0 and zero to 1. |

### Flow Control Nodes

| Type | Name | Ports | Description |
|---|---|---|---|
| `select` | IF / ELSE | In: `cond`, `a`, `b` / Out: `val` | If `cond != 0` outputs `a`, else `b`. |
| `toggle` | TOGGLE | In: `a` / Out: `val` | Inverts output state on rising edge of `a`. |
| `latch` | LATCH | In: `a`, `b` / Out: `val` | Signal on `a` sets output 1; signal on `b` resets to 0. |
| `timer` | TIMER | Out: `val` | Square wave oscillating between 1 and 0 based on configured seconds. |
| `delay` | DELAY | In: `a` / Out: `val` | Delays input signal by configured seconds. |
| `counter` | COUNTER | In: `a` / Out: `val` | Counts rising edges on `a`, wrapping at configured maximum. |
| `pid` | PID | In: `target`, `a` / Out: `val` | Closed-loop controller driving output based on error. |

### Output Nodes

| Type | Name | Target | Description |
|---|---|---|---|
| `motor_power` | MOTOR POWER | Motor | Drives motor -1.0 to +1.0 of rated torque. |
| `servo_target` | SERVO TARGET | Servo / Turret / Piston | Sets target angle (-90 to +90 deg) or piston stroke. |
| `weapon_fire` | WEAPON TRIGGER | Weapon | Non-zero value commands weapon fire. |
| `brake` | BRAKE | Chassis | Non-zero locks driven wheels. |

---

## Code Recipes

### Dual-Motor Tank Drive

```python
drive = clamp(forward() - back(), -1, 1)
motor("m_left", drive)
motor("m_right", drive)
```

### Skid-Steer Tank Mixer

```python
drive = forward() - back()
steer = turret()
left = clamp(drive + steer, -1, 1)
right = clamp(drive - steer, -1, 1)
motor("m_left", left)
motor("m_right", right)
```

### Radar Auto-Aim Turret

```python
bearing = sensor("radar#bearing")
distance = sensor("radar#range")

aim = pid("turret_aim", 0, bearing, 0.05, 0.001, 0.02)
servo("bearing_id", aim * 90)

if abs(bearing) < 5 and distance < 20:
    weapon("cannon_id", 1)
```

### Battery Conservation Mode

```python
charge = sensor("bat_id")
power = forward() - back()

if charge < 20:
    power = power * 0.5

motor("m1", clamp(power, -1, 1))
```

### Pulsed Burst Fire Sequencer

```python
step = recall("burst", 0)

if fire():
    step = step + 1
    if step < 5:
        weapon("gun_id", 1)
    elif step > 20:
        step = 0
else:
    step = 0

remember("burst", step)
```
