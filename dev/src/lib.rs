mod api;
mod host;
mod input;
mod pixels;

use serde_json::{json, Value};

wit_bindgen::generate!({ path: "../wasm/lnbits-extension.wit", world: "satoshisplacewasm", generate_all });
struct Extension;

type Reply = Result<Value, String>;

fn run(input: &str, handler: fn(&Value) -> Reply) -> String {
    let request = if input.is_empty() {
        Ok(json!({}))
    } else {
        serde_json::from_str(input)
    };
    let result = match request {
        Ok(value) if value.is_object() => handler(&value),
        _ => Err("request must be a JSON object.".into()),
    };
    match result {
        Ok(data) => json!({"ok": true, "data": data}),
        Err(error) => json!({"ok": false, "error": error}),
    }
    .to_string()
}

// Each WIT export has the same JSON envelope.
macro_rules! routes {
    ($($name:ident),+ $(,)?) => {
        impl Guest for Extension {
            $(fn $name(input:String) -> String { run(&input, api::$name) })+
        }
    };
}
routes!(
    list_place_wallets,
    create_place_wall,
    list_place_walls,
    delete_place_wall,
    get_public_place_wall,
    create_place_paint_invoice,
    record_place_payment
);
export!(Extension);
