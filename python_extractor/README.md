# yt-dlp Sibnet Custom Extractor Integration

This guide explains how to integrate the custom Sibnet extractor into your `yt-dlp` project.

## 1. File Placement

### Option A: Internal Extractor (Recommended for custom builds)
Move the file to the core extractor directory:
- **Path:** `yt-dlp/yt_dlp/extractor/sibnet.py`
- **Action:** Replace the existing `sibnet.py` file with this improved version.

### Option B: Plugin (Recommended for external use)
- **Path:** `yt_dlp_plugins/extractor/sibnet.py`
- **Action:** `yt-dlp` will automatically load any extractor found in the `yt_dlp_plugins` directory if it's in your Python path or working directory.

## 2. Registration (Required for Option A)

If you chose Option A, you must register the extractor in the central index.
1. Open `yt-dlp/yt_dlp/extractor/_extractors.py`.
2. Ensure `SibnetIE` is imported and listed in the `_EXTRACTORS` list.

```python
# In yt_dlp/extractor/_extractors.py
from .sibnet import SibnetIE
# ...
_EXTRACTORS = [
    # ...
    SibnetIE,
    # ...
]
```

## 3. Extraction Logic Details

The extractor follows a multi-stage discovery process:
1. **Session Warming:** Hits the main video page to bypass basic anti-bot session checks.
2. **Endpoint Rotation:** Tries Shell PHP, Player PHP, and JSON API endpoints.
3. **Token Injection:** Dynamically extracts `st` (signature) and `e` (expiry) tokens from the page source if the found URL is a relative slug.
4. **User-Agent Masquerading:** Uses modern browser headers to avoid "Access Denied" (403) errors.

## 4. Testing

Run the extractor directly to verify functionality:

```bash
python3 -m yt_dlp --list-extractors | grep Sibnet
python3 -m yt_dlp "https://video.sibnet.ru/video6160151/" -v --dump-json
```

## 5. Troubleshooting

- **403 Forbidden:** Ensure your IP is not blacklisted by Sibnet. Try using a proxy or VPN.
- **Video Deleted:** The extractor will throw a clear `ExtractorError` if the video is no longer available.
- **Missing Token:** Check the debug logs (`-v`) to see if the `st` or `e` tokens are missing from the page source.
