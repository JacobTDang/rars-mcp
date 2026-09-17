#!/usr/bin/env python3
import hashlib, json, sys
import pywellen

path = sys.argv[1]
wave = pywellen.Waveform(path)

def value_text(value):
    if isinstance(value, int):
        return str(value) if value in (0, 1) else format(value, 'b')
    return str(value).lower()

signals = []
end_time = 0
for var in wave.all_vars():
    transitions = [{"time": int(time), "value": value_text(value)} for time, value in var.tv]
    if transitions:
        end_time = max(end_time, transitions[-1]["time"])
    signals.append({"id": str(var.signal_id), "name": str(var.name), "path": str(var.full_name), "width": int(var.bitwidth), "type": str(var.var_type), "transitions": transitions})

with open(path, 'rb') as source:
    digest = hashlib.sha256(source.read()).hexdigest()
print(json.dumps({"version": 1, "sourceSha256": digest, "timescale": str(wave.timescale), "startTime": 0, "endTime": end_time, "scopes": sorted(str(scope.full_name) for scope in wave.all_scopes()), "signals": sorted(signals, key=lambda item: item["path"])}))
