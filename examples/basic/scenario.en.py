from mitm_gui import Script, Scenario, response

# Open http://example.com/api/hello through the mitm gui proxy.
# HTTPS requires SSL decryption to be enabled for example.com.
app = Script("Example · example.com", hosts=["example.com"], path_prefix="/api/")
demo = Scenario("demo", initial="Start")
app.use(demo)


@app.get("/api/hello")
def hello(request, ctx):
    # Variables are preserved between requests.
    ctx.state["visits"] = ctx.state.get("visits", 0) + 1
    return response(200, json={
        "message": "Hello from mitm gui!",
        "visits": ctx.state["visits"],
        "stage": ctx.stage,
    })


@demo.post("/api/finish", state="Start")
def finish(request, ctx):
    ctx.goto("Done")
    return response(200, json={"done": True})


@demo.get("/api/result", state="Done")
def result(request, ctx):
    return response(200, json={"message": "Scenario completed"})

# Other requests go to the server (unmatched="forward" is the default).
# To serve JSON from a file, choose a folder and return response(200, file="reply.json").
