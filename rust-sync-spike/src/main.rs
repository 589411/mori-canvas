// Minimal yrs (Rust) y-websocket server — to prove it interops with the classic
// yjs JS client (WebsocketProvider). Single shared doc, accepts any ws path.
use std::sync::Arc;
use futures_util::StreamExt;
use tokio::sync::Mutex;
use warp::ws::{WebSocket, Ws};
use warp::Filter;
use yrs::sync::Awareness;
use yrs::Doc;
use yrs_warp::broadcast::BroadcastGroup;
use yrs_warp::ws::{WarpSink, WarpStream};
use yrs_warp::AwarenessRef;

#[tokio::main]
async fn main() {
    let awareness: AwarenessRef = Arc::new(Awareness::new(Doc::new()));
    let bcast = Arc::new(BroadcastGroup::new(awareness, 32).await);

    let routes = warp::ws()
        .and(warp::any().map(move || bcast.clone()))
        .map(|ws: Ws, bcast: Arc<BroadcastGroup>| ws.on_upgrade(move |socket| peer(socket, bcast)));

    println!("yrs-spike on ws://127.0.0.1:1235 (single room)");
    warp::serve(routes).run(([127, 0, 0, 1], 1235)).await;
}

async fn peer(ws: WebSocket, bcast: Arc<BroadcastGroup>) {
    let (sink, stream) = ws.split();
    let sink = Arc::new(Mutex::new(WarpSink::from(sink)));
    let stream = WarpStream::from(stream);
    let sub = bcast.subscribe(sink, stream);
    let _ = sub.completed().await;
}
