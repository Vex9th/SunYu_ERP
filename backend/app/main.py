from fastapi import FastAPI

app = FastAPI(title="SunYu ERP")


@app.get("/api/health")
def get_health() -> dict[str, str]:
    return {"status": "ok"}
