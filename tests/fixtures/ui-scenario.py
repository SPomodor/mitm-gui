# Multi-stage fixture for UI regression tests; not bundled with the product.
from chls import Script, Scenario, response

app = Script("UI test", path_prefix="/driver/", unmatched="block")
order = Scenario("order", initial="Собирается")
app.use(order)
stages = [
    ("Собирается", "assembling"),
    ("В магазин", "to_store"),
    ("В магазине", "at_store"),
    ("К клиенту", "to_customer"),
    ("Передать заказ", "at_customer"),
    ("Вернуться", "returning"),
    ("Завершён", "completed"),
]

@app.get("/driver/demo/order")
def get_order(request, ctx):
    return response(200, json={"status": dict(stages)[ctx.stage]})

def add_transition(stage, path, destination):
    @order.post(path, state=stage)
    def advance(request, ctx):
        ctx.goto(destination)
        return response(200)

confirm = "/driver/v1/cargo-pro-api/grocery/v1/order/exchange/confirm"
arrive = "/driver/v1/cargo-pro-api/grocery/v1/order/arrive-at-point"
for index, (stage, _) in enumerate(stages):
    if index < len(stages) - 1:
        add_transition(stage, arrive if index in (1, 3) else confirm, stages[index + 1][0])
    else:
        @order.get("/driver/demo/completed", state=stage)
        def completed(request, ctx):
            return response(200)
