"""Шаблон заказа 187. Выберите папку, содержащую 187 с вашими JSON."""
from chls import Script, Scenario, response

app = Script("Заказ косметики · 187", path_prefix="/driver/")
order = Scenario("order", initial="Собирается")
app.use(order)

info = "/driver/v1/grocery-pro-bdu/v1/order/info"
polling = "/driver/polling/order"
state = "/driver/v1/cargo-performer-orders-app-api/v2/state"
init = "/driver/v1/cargo-pro-api/grocery/v1/order/exchange/init"
confirm = "/driver/v1/cargo-pro-api/grocery/v1/order/exchange/confirm"
arrive = "/driver/v1/cargo-pro-api/grocery/v1/order/arrive-at-point"

stages = [
    ("Собирается", "0_income_order_info.json", confirm),
    ("В магазин", "1_to_beauty_order_info.json", arrive),
    ("В магазине", "2_at_beauty_order_info.json", confirm),
    ("К клиенту", "3_to_client_order_info.json", arrive),
    ("Передать заказ", "4_at_client_order_info.json", confirm),
    ("Вернуться", "5_returning_order_info.json", confirm),
    ("Завершён", "6_complete_order_info.json", None),
]

def fixture(name):
    return "187/" + name

app.files = [fixture(name) for _, name, _ in stages] + [fixture(name) for name in [
    "0_polling_order_income.json", "0_cargo_state.json", "0_voiceforwarding.json",
    "shifts_actual_in_progress.json", "6_complete_exchange_init.json",
    "6_complete_exchange_confirm.json", "6_polling_order_complete.json", "6_cargo_state_empty.json",
    "1_pickup_exchange_init.json", "1_pickup_exchange_confirm.json",
    "4_dropoff_exchange_init.json", "4_dropoff_exchange_confirm.json",
]]

def add_stage(stage, file, transition_path, destination):
    @order.route("*", info, state=stage)
    def get_info(request, ctx):
        body = ctx.load_json(fixture(file))
        # Пример изменения единственного поля: body.set("time", 123)
        return response(200, json=body)

    if transition_path:
        @order.post(transition_path, state=stage)
        def advance(request, ctx):
            ctx.goto(destination)
            # Ответ и переход заданы явно. Повторы обрабатываются обычным образом.
            if stage == "Вернуться":
                return response(200, json=ctx.load_json(fixture("6_complete_exchange_confirm.json")))
            if stage == "В магазине":
                return response(200, json=ctx.load_json(fixture("1_pickup_exchange_confirm.json")))
            if stage == "Передать заказ":
                # После подтверждения передачи возврат обрабатывает настоящий сервер.
                ctx.stop()
                return response(200, json=ctx.load_json(fixture("4_dropoff_exchange_confirm.json")))
            return response(200)

for index, (stage, file, transition_path) in enumerate(stages):
    destination = stages[index + 1][0] if transition_path else None
    add_stage(stage, file, transition_path, destination)

@app.route("*", polling)
def get_polling(request, ctx):
    file = "6_polling_order_complete.json" if ctx.stage == "Завершён" else "0_polling_order_income.json"
    return response(200, json=ctx.load_json(fixture(file)))

@app.route("*", state)
def get_state(request, ctx):
    file = "6_cargo_state_empty.json" if ctx.stage == "Завершён" else "0_cargo_state.json"
    return response(200, json=ctx.load_json(fixture(file)))

@app.route("*", init)
def get_init(request, ctx):
    if ctx.stage in ("Вернуться", "Завершён"):
        file = "6_complete_exchange_init.json"
    elif ctx.stage in ("К клиенту", "Передать заказ"):
        file = "4_dropoff_exchange_init.json"
    else:
        file = "1_pickup_exchange_init.json"
    return response(200, json=ctx.load_json(fixture(file)))

@order.route("*", confirm, state="Завершён")
def complete_confirm(request, ctx):
    return response(200, json=ctx.load_json(fixture("6_complete_exchange_confirm.json")))

def add_empty(path):
    @app.route("*", path)
    def acknowledge(request, ctx):
        return response(200)

for path in [
    confirm,
    "/driver/v1/cargo-pro-api/cargo/v1/order/exchange/confirm",
    "/driver/v1/cargo-performer-orders-app-api/seen",
    "/driver/v1/cargo-performer-orders-app-api/requestconfirm/driving",
    "/driver/v1/cargo-performer-orders-app-api/requestconfirm/complete",
]:
    add_empty(path)

@app.route("*", "/driver/v1/cargo-pro-bdu/cargo/v1/order/voiceforwarding")
def voice(request, ctx):
    return response(200, json=ctx.load_json(fixture("0_voiceforwarding.json")))

@app.route("*", "/driver/v1/lavka_timetable/v1/courier-shifts/actual")
def shifts(request, ctx):
    return response(200, json=ctx.load_json(fixture("shifts_actual_in_progress.json")))
