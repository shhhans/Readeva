"""Readeva 的 Docling 解析服务（docling-serve 兼容线协议的最小本地实现）。

本服务是独立进程（Windows 本机用 conda 环境 `readeva` 运行），负责把 docling
库包装成 HTTP 接口；Readeva 服务端通过可配置地址（READEVA_DOCLING_URL）访问它，
发送单页 PDF 字节流并消费结构化结果，契约不依赖共享文件路径。

线协议与 docling-serve 保持一致（便于将来替换为远端 docling-serve 或解析项目
的正式服务）：

- POST /v1/convert/file/async   提交转换（multipart，files 字段）→ {task_id, task_status}
- GET  /v1/status/poll/{task_id} 任务状态 pending|started|success|failure
- GET  /v1/result/{task_id}     结果 {document: {json_content}, status, errors}

服务本身无持久状态（任务表保存在内存），解析在进程内线程池执行。

运行（仓库根目录）：

    conda run -n readeva python -m uvicorn docling_service.main:app --host 127.0.0.1 --port 5001
"""

from __future__ import annotations

import io
import threading
import uuid
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from typing import Optional

from fastapi import FastAPI, File, HTTPException, UploadFile

from docling.datamodel.base_models import ConversionStatus, InputFormat
from docling.datamodel.pipeline_options import PdfPipelineOptions
from docling.document_converter import DocumentConverter, PdfFormatOption
from docling_core.types.io import DocumentStream

app = FastAPI(title="Readeva Docling Service", version="0.1.0")

# 图片以内嵌 data URI 随 DoclingDocument 返回（客户端直接展示图片资源）。
_PIPELINE_OPTIONS = PdfPipelineOptions()
_PIPELINE_OPTIONS.generate_picture_images = True
_PIPELINE_OPTIONS.images_scale = 2.0

_CONVERTER = DocumentConverter(
    format_options={
        InputFormat.PDF: PdfFormatOption(pipeline_options=_PIPELINE_OPTIONS),
    }
)

# 解析是 CPU 重活；单线程串行即可（当前页解析一次一页）。
_EXECUTOR = ThreadPoolExecutor(max_workers=1, thread_name_prefix="docling")


@dataclass
class _Task:
    task_id: str
    status: str = "started"  # pending|started|success|failure
    json_content: Optional[dict] = None
    errors: list = field(default_factory=list)

    def detail(self) -> dict:
        return {
            "task_id": self.task_id,
            "task_status": self.status,
            "task_position": 0,
            "task_meta": None,
        }


_TASKS: dict[str, _Task] = {}
_LOCK = threading.Lock()

_SUCCESS_STATUSES = {ConversionStatus.SUCCESS, ConversionStatus.PARTIAL_SUCCESS}


@app.get("/health")
def health() -> dict:
    return {"ok": True, "service": "readeva-docling"}


@app.post("/v1/convert/file/async")
async def convert_file_async(files: list[UploadFile] = File(...)) -> dict:
    """提交字节流转换任务；立即返回 task_id，转换在后台线程执行。"""
    if not files:
        raise HTTPException(status_code=400, detail="no file provided")
    upload = files[0]
    payload = await upload.read()
    task = _Task(task_id=uuid.uuid4().hex)
    with _LOCK:
        _TASKS[task.task_id] = task
    _EXECUTOR.submit(_convert, task, payload, upload.filename or "page.pdf")
    return task.detail()


def _convert(task: _Task, payload: bytes, filename: str) -> None:
    try:
        stream = DocumentStream(name=filename, stream=io.BytesIO(payload))
        result = _CONVERTER.convert(stream)
        if result.status not in _SUCCESS_STATUSES:
            task.status = "failure"
            task.errors = [{"kind": "conversion", "message": str(result.status)}]
            return
        task.json_content = result.document.export_to_dict()
        task.status = "success"
    except Exception as exc:  # noqa: BLE001 转换异常统一进入任务失败状态
        task.status = "failure"
        task.errors = [{"kind": "internal", "message": str(exc)}]


@app.get("/v1/status/poll/{task_id}")
def status_poll(task_id: str) -> dict:
    task = _TASKS.get(task_id)
    if task is None:
        raise HTTPException(status_code=404, detail="unknown task")
    return task.detail()


@app.get("/v1/result/{task_id}")
def fetch_result(task_id: str) -> dict:
    task = _TASKS.get(task_id)
    if task is None:
        raise HTTPException(status_code=404, detail="unknown task")
    if task.status not in ("success", "failure"):
        return {"document": {}, "status": task.status, "errors": []}
    if task.status == "failure":
        return {"document": {}, "status": "failure", "errors": task.errors}
    return {
        "document": {"md_content": "", "json_content": task.json_content},
        "status": "success",
        "errors": task.errors,
    }
