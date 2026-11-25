use crate::{host, input::*, pixels::Grid, Reply};
use serde_json::{json, Value};
const WALLS: &str = "place_walls";
const PAYMENTS: &str = "place_payments";

pub fn list_place_wallets(_: &Value) -> Reply {
    Ok(json!({"wallets":host::wallets()}))
}
pub fn create_place_wall(req: &Value) -> Reply {
    let wallet = required(alias(req, "walletId", "wallet_id"), "walletId", 128)?;
    let name = clean(alias(req, "walletName", "wallet_name"), 120);
    let width = integer(&req["width"], 64, 8, 128)?;
    let height = integer(&req["height"], 64, 8, 128)?;
    let now = host::now();
    let mut id = clean(&req["id"], 128);
    if id.is_empty()
        || !id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'-'))
    {
        id = host::id("wall");
    }
    let title = clean(&req["name"], 80);
    let wall = json!({"id":id,"name":if title.is_empty(){"Satoshi wall"}else{&title},"description":clean(&req["description"],280),
        "wallet_id":wallet,"wallet_name":if name.is_empty(){&wallet}else{&name},"width":width,"height":height,
        "price_per_pixel":integer(alias(req,"pricePerPixel","price_per_pixel"),1,1,100000)?,"enabled":req["enabled"]!=false,
        "canvas_json":"[]","paint_count":0,"paid_pixels":0,"created_at":now,"updated_at":now});
    host::set(WALLS, &wall)?;
    host::log(&format!("satoshisplacewasm: created wall {id}"), "info");
    Ok(json!({"wall":view(&wall,false)?,"publicUrl":format!("/satoshisplacewasm/walls/{id}")}))
}
pub fn list_place_walls(req: &Value) -> Reply {
    let (limit, offset) = pagination(req, 10);
    let sort = match s(&req["sortBy"]) {
        "name" => "name",
        "pricePerPixel" => "price_per_pixel",
        "paintCount" => "paint_count",
        "paidPixels" => "paid_pixels",
        _ => "created_at",
    };
    let page = host::page(
        WALLS,
        json!({"search":clean(&req["search"],256),"searchFields":["name","description"],"sortBy":sort,
        "descending":req["descending"]==true||req["descending"]=="true","limit":limit,"offset":offset}),
    )?;
    let walls = page
        .rows
        .iter()
        .map(|w| view(w, false))
        .collect::<Result<Vec<_>, _>>()?;
    Ok(json!({"walls":walls,"total":page.total}))
}
pub fn delete_place_wall(req: &Value) -> Reply {
    let wall = load(req, false)?;
    let id = s(&wall["id"]);
    loop {
        let page = host::page(
            PAYMENTS,
            json!({"filters":{"wall_id":id},"sortBy":"created_at","limit":500}),
        )?;
        for row in &page.rows {
            host::delete(PAYMENTS, s(&row["id"]))?;
        }
        if page.rows.is_empty() || page.rows.len() as u64 >= page.total {
            break;
        }
    }
    host::delete(WALLS, id)?;
    host::log(&format!("satoshisplacewasm: deleted wall {id}"), "info");
    Ok(json!({"deleted":true,"wallId":id}))
}
pub fn get_public_place_wall(req: &Value) -> Reply {
    Ok(json!({"wall":view(&load(req,true)?,true)?}))
}
pub fn create_place_paint_invoice(req: &Value) -> Reply {
    let wall = load(req, true)?;
    if wall["enabled"] != true {
        return Err("This wall is not accepting graffiti.".into());
    }
    let grid = Grid::read(&wall)?;
    let patch = grid.patch(alias(req, "pixels", "patch"))?;
    let encoded = grid.encode(&patch);
    if encoded.len() > 3500 {
        return Err("Paint fewer pixels in one invoice.".into());
    }
    let id = s(&wall["id"]);
    let count = patch.len();
    let amount = count as i64 * i(&wall["price_per_pixel"]).max(1);
    let memo = format!(
        "{count} pixel{} on {}",
        if count == 1 { "" } else { "s" },
        s(&wall["name"])
    );
    let mut invoice = host::invoice(
        id,
        amount as f64,
        "sat",
        &memo,
        vec![
            ("wall_id".into(), id.into()),
            ("patch_json".into(), encoded),
            ("amount".into(), amount.to_string()),
        ],
    );
    invoice["amount"] = amount.into();
    invoice["pixelCount"] = count.into();
    Ok(invoice)
}
pub fn record_place_payment(event: &Value) -> Reply {
    let p = &event["payment"];
    let extra = &event["extra"];
    let pe = &p["extra"];
    let nested = first(&[
        &extra["extra_satoshisplacewasm"],
        &pe["extra_satoshisplacewasm"],
    ]);
    let hash = required(
        first(&[
            &event["paymentHash"],
            &event["payment_hash"],
            &p["payment_hash"],
            &p["paymentHash"],
            &event["checking_id"],
            &p["checking_id"],
        ]),
        "paymentHash",
        128,
    )?;
    let id = required(
        first(&[&nested["wall_id"], &extra["wall_id"], &pe["wall_id"]]),
        "wall_id",
        128,
    )?;
    let existing = host::get(PAYMENTS, &hash)?;
    if existing["status"] == "paid" {
        return Ok(json!({"payment":payment_view(&existing),"status":"paid"}));
    }
    let mut wall = host::get(WALLS, &id)?;
    if wall.is_null() {
        return Err("Wall not found.".into());
    }
    let grid = Grid::read(&wall)?;
    let patch = grid.decode(&clean(
        first(&[
            &nested["patch_json"],
            &extra["patch_json"],
            &pe["patch_json"],
        ]),
        20000,
    ))?;
    let count = patch.len() as i64;
    let amount = count * i(&wall["price_per_pixel"]).max(1);
    let msat = if num(&event["amount"], 0.) != 0. {
        num(&event["amount"], 0.)
    } else {
        num(&p["amount"], 0.)
    };
    let paid = msat.is_finite() && (msat == 0. || (msat.abs() / 1000.).trunc() == amount as f64);
    let status = if paid { "paid" } else { "amount-mismatch" };
    let now = host::now();
    if paid {
        let mut canvas = grid.canvas(&wall)?;
        grid.apply(&mut canvas, &patch);
        wall["canvas_json"] = canvas.to_string().into();
        wall["paid_pixels"] = (i(&wall["paid_pixels"]) + count).into();
        wall["paint_count"] = (i(&wall["paint_count"]) + 1).into();
        wall["updated_at"] = now.into();
        host::set(WALLS, &wall)?;
    }
    let pixels: Vec<_> = patch.iter().map(|p| p.json()).collect();
    let record = json!({"id":hash,"wall_id":id,"pixel_count":count,"amount":amount,"status":status,
        "patch_json":existing["patch_json"].as_str().map(str::to_owned).unwrap_or_else(||Value::Array(pixels).to_string()),
        "created_at":existing["created_at"].as_u64().unwrap_or(now),"paid_at":if paid{json!(now)}else{existing["paid_at"].clone()}});
    host::set(PAYMENTS, &record)?;
    let mut result = json!({"payment":payment_view(&record),"status":status});
    if paid {
        result["wall"] = view(&wall, true)?;
    }
    Ok(result)
}
fn load(req: &Value, public: bool) -> Reply {
    let id = required(alias(req, "wallId", "wall_id"), "wallId", 128)?;
    let row = if public {
        host::get_public(WALLS, &id)?
    } else {
        host::get(WALLS, &id)?
    };
    if row.is_null() {
        Err("Wall not found.".into())
    } else {
        Ok(row)
    }
}
fn view(w: &Value, public: bool) -> Reply {
    let mut v = json!({"id":w["id"],"name":s(&w["name"]),"description":s(&w["description"]),"width":i(&w["width"]),
        "height":i(&w["height"]),"pricePerPixel":i(&w["price_per_pixel"]).max(1),"enabled":w["enabled"]==true,"paintCount":i(&w["paint_count"]),
        "paidPixels":i(&w["paid_pixels"]),"createdAt":i(&w["created_at"]),"updatedAt":i(&w["updated_at"])});
    if public {
        v["canvas"] = Grid::read(w)?.canvas(w)?;
    } else {
        v["walletId"] = s(&w["wallet_id"]).into();
        v["walletName"] = s(&w["wallet_name"]).into();
    }
    Ok(v)
}
fn payment_view(p: &Value) -> Value {
    json!({"id":p["id"],"wallId":p["wall_id"],"pixelCount":i(&p["pixel_count"]),"amount":i(&p["amount"]),"status":p["status"],"paidAt":i(&p["paid_at"])})
}
