use std::time::Instant;

#[derive(Debug, Clone, Copy)]
pub enum PerfTraceName {
    SidecarBoot,
    Turn,
    Runtime,
    StorageIo,
    BackgroundJob,
}

impl PerfTraceName {
    fn as_str(self) -> &'static str {
        match self {
            PerfTraceName::SidecarBoot => "sidecar_boot",
            PerfTraceName::Turn => "turn",
            PerfTraceName::Runtime => "runtime",
            PerfTraceName::StorageIo => "storage_io",
            PerfTraceName::BackgroundJob => "background_job",
        }
    }
}

#[derive(Debug, Clone)]
pub struct PerfTrace<'a> {
    pub trace: PerfTraceName,
    pub phase: &'a str,
    pub duration_ms: Option<f64>,
    pub session_id: Option<&'a str>,
    pub tab_id: Option<&'a str>,
    pub owner_id: Option<&'a str>,
    pub request_id: Option<&'a str>,
    pub turn_id: Option<&'a str>,
    pub runtime: Option<&'a str>,
    pub status: Option<&'a str>,
    pub size_bytes: Option<u64>,
    pub count: Option<u64>,
    pub detail: Vec<(&'a str, String)>,
}

impl<'a> PerfTrace<'a> {
    pub fn new(trace: PerfTraceName, phase: &'a str) -> Self {
        Self {
            trace,
            phase,
            duration_ms: None,
            session_id: None,
            tab_id: None,
            owner_id: None,
            request_id: None,
            turn_id: None,
            runtime: None,
            status: None,
            size_bytes: None,
            count: None,
            detail: Vec::new(),
        }
    }

    pub fn duration_ms(mut self, duration_ms: f64) -> Self {
        self.duration_ms = Some(duration_ms);
        self
    }

    pub fn session_id(mut self, session_id: Option<&'a str>) -> Self {
        self.session_id = session_id;
        self
    }

    pub fn owner_id(mut self, owner_id: Option<&'a str>) -> Self {
        self.owner_id = owner_id;
        self
    }

    pub fn runtime(mut self, runtime: Option<&'a str>) -> Self {
        self.runtime = runtime;
        self
    }

    pub fn status(mut self, status: &'a str) -> Self {
        self.status = Some(status);
        self
    }

    pub fn size_bytes(mut self, size_bytes: u64) -> Self {
        self.size_bytes = Some(size_bytes);
        self
    }

    pub fn count(mut self, count: u64) -> Self {
        self.count = Some(count);
        self
    }

    pub fn detail(mut self, key: &'a str, value: impl ToString) -> Self {
        self.detail.push((key, value.to_string()));
        self
    }
}

pub fn trace_start() -> Instant {
    Instant::now()
}

pub fn elapsed_ms(start: Instant) -> f64 {
    let d = start.elapsed();
    d.as_secs_f64() * 1000.0
}

fn sanitize(value: &str) -> String {
    value
        .chars()
        .map(|c| if c.is_ascii_whitespace() { '_' } else { c })
        .take(160)
        .collect()
}

pub fn emit_perf_trace(event: PerfTrace<'_>) {
    let mut fields = vec![
        format!("trace={}", event.trace.as_str()),
        format!("phase={}", sanitize(event.phase)),
    ];

    if let Some(v) = event.duration_ms {
        fields.push(format!("durationMs={:.3}", v));
    }
    if let Some(v) = event.status {
        fields.push(format!("status={}", sanitize(v)));
    }
    if let Some(v) = event.runtime {
        fields.push(format!("runtime={}", sanitize(v)));
    }
    if let Some(v) = event.session_id {
        fields.push(format!("sessionId={}", sanitize(v)));
    }
    if let Some(v) = event.tab_id {
        fields.push(format!("tabId={}", sanitize(v)));
    }
    if let Some(v) = event.owner_id {
        fields.push(format!("ownerId={}", sanitize(v)));
    }
    if let Some(v) = event.request_id {
        fields.push(format!("requestId={}", sanitize(v)));
    }
    if let Some(v) = event.turn_id {
        fields.push(format!("turnId={}", sanitize(v)));
    }
    if let Some(v) = event.size_bytes {
        fields.push(format!("sizeBytes={}", v));
    }
    if let Some(v) = event.count {
        fields.push(format!("count={}", v));
    }
    for (key, value) in event.detail {
        fields.push(format!("detail.{}={}", sanitize(key), sanitize(&value)));
    }

    crate::ulog_info!("[perf] {}", fields.join(" "));
}
