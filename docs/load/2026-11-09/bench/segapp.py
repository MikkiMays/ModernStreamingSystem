# Кусок кинозала из общей памяти — тот же ответ, что `facade._kept`: Response(bytes) через FastAPI/uvicorn (h11).
import os
from fastapi import FastAPI, Response
app = FastAPI()
BODY = os.urandom(2 * 1024 * 1024)
@app.get("/seg/{i}")
async def seg(i: int):
    return Response(BODY, media_type="video/mp2t", headers={"Cache-Control": "private, max-age=600"})
