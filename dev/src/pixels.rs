use crate::input::*;
use serde_json::{json, Value};
use std::collections::BTreeMap;

const WHITE: &str = "#ffffff";
const BASE64: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
pub struct Grid {
    width: usize,
    height: usize,
}
pub struct Pixel {
    x: usize,
    y: usize,
    color: String,
}
impl Pixel {
    pub fn json(&self) -> Value {
        json!({"x":self.x,"y":self.y,"color":self.color})
    }
}
impl Grid {
    pub fn read(wall: &Value) -> Result<Self, String> {
        Ok(Self {
            width: integer(&wall["width"], 0, 1, 128)? as usize,
            height: integer(&wall["height"], 0, 1, 128)? as usize,
        })
    }
    pub fn patch(&self, value: &Value) -> Result<Vec<Pixel>, String> {
        let raw = value
            .as_array()
            .filter(|a| !a.is_empty())
            .ok_or("Select at least one pixel.")?;
        let mut pixels: Vec<Pixel> = Vec::new();
        let mut positions = BTreeMap::new();
        for row in raw {
            if !row.is_object() {
                return Err("Invalid pixel.".into());
            }
            let x = integer(&row["x"], -1, 0, self.width as i64 - 1)? as usize;
            let y = integer(&row["y"], -1, 0, self.height as i64 - 1)? as usize;
            let pos = *positions.entry((x, y)).or_insert(pixels.len());
            let pixel = Pixel {
                x,
                y,
                color: color(&row["color"])?,
            };
            if pos == pixels.len() {
                pixels.push(pixel)
            } else {
                pixels[pos] = pixel
            }
        }
        Ok(pixels)
    }
    pub fn canvas(&self, wall: &Value) -> Result<Value, String> {
        let raw = serde_json::from_str::<Value>(s(&wall["canvas_json"])).unwrap_or(Value::Null);
        let mut result = json!({});
        let mut insert = |index: usize, v: &Value| -> Result<(), String> {
            if index < self.width * self.height && !s(v).is_empty() {
                let c = color(v)?;
                if c != WHITE {
                    result[index.to_string()] = c.into();
                }
            }
            Ok(())
        };
        if let Some(a) = raw.as_array() {
            for (i, v) in a.iter().enumerate() {
                insert(i, v)?;
            }
        }
        if let Some(o) = raw.as_object() {
            for (k, v) in o {
                if let Ok(i) = k.parse() {
                    insert(i, v)?;
                }
            }
        }
        Ok(result)
    }
    pub fn apply(&self, canvas: &mut Value, patch: &[Pixel]) {
        for p in patch {
            canvas[(p.y * self.width + p.x).to_string()] = p.color.clone().into();
        }
    }
    pub fn encode(&self, patch: &[Pixel]) -> String {
        let compact = patch
            .iter()
            .map(|p| format!("{},{},{}", base36(p.x), base36(p.y), &p.color[1..]))
            .collect::<Vec<_>>()
            .join(";");
        let count = (self.width * self.height).div_ceil(8);
        // Allocate a bitset only while it can still beat the sparse representation.
        let mut groups: Vec<(&str, Vec<u8>)> = Vec::new();
        let mut indices = BTreeMap::new();
        for p in patch {
            let group = *indices.entry(&p.color).or_insert(groups.len());
            if group == groups.len() {
                if 2 + (group + 1) * (8 + 4 * count.div_ceil(3)) >= compact.len() {
                    return compact;
                }
                groups.push((&p.color[1..], vec![0; count]));
            }
            let index = p.y * self.width + p.x;
            groups[group].1[index / 8] |= 1 << (index % 8);
        }
        format!(
            "v2|{}",
            groups
                .iter()
                .map(|(c, b)| format!("{c}:{}", base64(b)))
                .collect::<Vec<_>>()
                .join(";")
        )
    }
    pub fn decode(&self, raw: &str) -> Result<Vec<Pixel>, String> {
        if raw.starts_with('[') {
            return self.patch(&serde_json::from_str(raw).map_err(|_| "Invalid pixel patch.")?);
        }
        let mut pixels = Vec::new();
        if let Some(groups) = raw.strip_prefix("v2|") {
            for group in groups.split(';').filter(|g| !g.is_empty()) {
                let (c, encoded) = group.split_once(':').ok_or("Invalid pixel patch.")?;
                for (byte_index, byte) in unbase64(encoded).into_iter().enumerate() {
                    for bit in 0..8 {
                        let index = byte_index * 8 + bit;
                        if index < self.width * self.height && byte & (1 << bit) != 0 {
                            pixels.push(json!({"x":index%self.width,"y":index/self.width,"color":format!("#{c}")}));
                        }
                    }
                }
            }
        } else if !raw.is_empty() {
            for item in raw.split(';') {
                let mut parts = item.split(',');
                let mut coord = || {
                    usize::from_str_radix(parts.next().unwrap_or(""), 36)
                        .map_err(|_| "Invalid pixel.")
                };
                let x = coord()?;
                let y = coord()?;
                pixels.push(json!({"x":x,"y":y,"color":format!("#{}",parts.next().unwrap_or(""))}));
            }
        }
        self.patch(&Value::Array(pixels))
    }
}
fn color(v: &Value) -> Result<String, String> {
    let c = clean(v, 7).to_ascii_lowercase();
    if c.len() != 7 || !c.starts_with('#') || !c[1..].bytes().all(|c| c.is_ascii_hexdigit()) {
        Err("Pixel color must be #rrggbb.".into())
    } else {
        Ok(c)
    }
}
fn base36(n: usize) -> String {
    let digits = b"0123456789abcdefghijklmnopqrstuvwxyz";
    if n < 36 {
        (digits[n] as char).to_string()
    } else {
        format!("{}{}", digits[n / 36] as char, digits[n % 36] as char)
    }
}
fn base64(bytes: &[u8]) -> String {
    let mut result = String::new();
    for b in bytes.chunks(3) {
        let word = (u32::from(b[0]) << 16)
            | (u32::from(*b.get(1).unwrap_or(&0)) << 8)
            | u32::from(*b.get(2).unwrap_or(&0));
        for i in 0..4 {
            result.push(if i > b.len() {
                '='
            } else {
                BASE64[((word >> (18 - i * 6)) & 63) as usize] as char
            });
        }
    }
    result
}
fn unbase64(s: &str) -> Vec<u8> {
    let (mut buffer, mut bits) = (0u32, 0);
    let mut out = Vec::new();
    for c in s.bytes() {
        if let Some(code) = BASE64.iter().position(|b| *b == c) {
            buffer = (buffer << 6) | code as u32;
            bits += 6;
            if bits >= 8 {
                bits -= 8;
                out.push((buffer >> bits) as u8);
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn legacy_and_compact_patches() {
        let grid = Grid {
            width: 8,
            height: 8,
        };
        for raw in [
            r##"[{"x":0,"y":0,"color":"#0011ff"}]"##,
            "0,0,0011ff",
            "v2|0011ff:AQAAAAAAAAA=",
        ] {
            let patch = grid.decode(raw).unwrap();
            assert_eq!(grid.encode(&patch), "0,0,0011ff");
        }
        let raw = (0..64)
            .map(|i| json!({"x":i%8,"y":i/8,"color":"#0011ff"}))
            .collect();
        let packed = grid.encode(&grid.patch(&Value::Array(raw)).unwrap());
        assert_eq!(packed, "v2|0011ff://////////8=");
        assert_eq!(grid.decode(&packed).unwrap().len(), 64);
    }
}
