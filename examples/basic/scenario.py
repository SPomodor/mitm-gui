from mitm_gui import Script, Scenario, response

# Откройте http://example.com/api/hello через прокси mitm gui.
# HTTPS требует включённой расшифровки SSL для example.com.
app = Script("Пример · example.com", hosts=["example.com"], path_prefix="/api/")
demo = Scenario("demo", initial="Начало")
app.use(demo)


@app.get("/api/hello")
def hello(request, ctx):
    # Переменные сохраняются между запросами.
    ctx.state["visits"] = ctx.state.get("visits", 0) + 1
    return response(200, json={
        "message": "Привет из mitm gui!",
        "visits": ctx.state["visits"],
        "stage": ctx.stage,
    })


@demo.post("/api/finish", state="Начало")
def finish(request, ctx):
    ctx.goto("Готово")
    return response(200, json={"done": True})


@demo.get("/api/result", state="Готово")
def result(request, ctx):
    return response(200, json={"message": "Сценарий завершён"})

# Остальные запросы уходят на сервер (unmatched="forward" по умолчанию).
# Для JSON из файла выберите папку и верните response(200, file="reply.json").
