const { requirePython, run } = require("./python.cjs");
run(requirePython(), ["-m", "pytest", "tests", "-q", ...process.argv.slice(2)]);
