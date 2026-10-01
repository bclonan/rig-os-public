use serde_json::{Value, json};
use std::io::{self, BufRead, Write};
#[cfg(windows)]
mod accessibility;
#[cfg(windows)]
mod events;
#[cfg(windows)]
mod windows;
fn main() {
    #[cfg(windows)]
    let mut host = windows::Host::new();
    for line in io::stdin().lock().lines() {
        let Ok(line) = line else { break };
        let request: Value = match serde_json::from_str(&line) {
            Ok(v) => v,
            Err(e) => {
                println!("{}", json!({"error":e.to_string()}));
                continue;
            }
        };
        #[cfg(windows)]
        let result = host.call(&request);
        #[cfg(not(windows))]
        let result: Result<Value, String> = Err(
            "UNSUPPORTED_PLATFORM: native Windows bridge requires an interactive Windows session"
                .into(),
        );
        let response = match result {
            Ok(v) => json!({"id":request["id"],"result":v}),
            Err(e) => json!({"id":request["id"],"error":e}),
        };
        println!("{response}");
        let _ = io::stdout().flush();
    }
}
