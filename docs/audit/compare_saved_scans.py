"""Read-only comparison of two existing v9 scans. Does not call providers."""
import hashlib
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SCANS = [
    "2026-10-06T15-22-40-116Z_40298a8a-178e-4d1d-85d2-aea798ec1f9c",
    "2026-10-06T15-25-28-310Z_ba7c44fb-580b-44ed-aab4-a6269dc01983",
]


def read_scan(name):
    directory = ROOT / "scan-results" / name
    result = json.loads((directory / "result.json").read_text())
    traces = json.loads((directory / "openai-analysis.json").read_text())
    reports = {v["videoId"]: v for v in result["videoReports"]}
    videos = {}
    for trace in traces:
        video_id = trace["videoId"]
        report = reports[video_id]
        scenes = report["scenes"]
        videos[video_id] = {
            "transcriptSha256": hashlib.sha256(trace["normalizedTranscript"].encode()).hexdigest(),
            "requestMetadata": trace["requestMetadata"],
            "detectorRequestId": trace["provider"].get("requestId"),
            "detectorCandidates": len(trace["parsedResult"]["classifiedEvents"]),
            "reviewStatus": trace.get("review", {}).get("status", {}).get("status"),
            "mainScenes": sum(s.get("attention") == "main" for s in scenes),
            "detailScenes": sum(s.get("attention") == "details" for s in scenes),
            "highScenes": sum(s["level"] == "high" for s in scenes),
            "summary": report.get("contentSummary"),
        }
    return {"scan": name, "profile": result["profile"], "timings": result.get("timings"), "videos": videos}


scans = [read_scan(name) for name in SCANS]
common_ids = sorted(set(scans[0]["videos"]) & set(scans[1]["videos"]))
assert len(common_ids) == 10
for video_id in common_ids:
    left, right = (scan["videos"][video_id] for scan in scans)
    assert left["transcriptSha256"] == right["transcriptSha256"]
    assert left["requestMetadata"] == right["requestMetadata"]
print(json.dumps({
    "note": "Same normalized transcripts and recorded detector metadata; batch composition/order is not controlled. This is not an accuracy estimate or a controlled batching experiment.",
    "matchingTranscriptsAndMetadata": len(common_ids),
    "scans": scans,
}, ensure_ascii=False, indent=2))
