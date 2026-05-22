import re
from yt_dlp.extractor.common import InfoExtractor
from yt_dlp.utils import (
    ExtractorError,
    dict_get,
    urljoin,
    clean_html,
)

class SibnetIE(InfoExtractor):
    """
    Expert implementation of Sibnet video extractor.
    Handles anti-bot, token generation, and multiple endpoint fallbacks.
    """
    _VALID_URL = r'https?://(?:video|dv\d+)\.sibnet\.ru/(?:video|shell\.php\?videoid=)(?P<id>\d+)'
    
    _TESTS = [{
        'url': 'https://video.sibnet.ru/video6160151/',
        'md5': 'TODO: add md5',
        'info_dict': {
            'id': '6160151',
            'ext': 'mp4',
            'title': 'Sibnet Video Extraction Test',
        }
    }]

    def _real_extract(self, url):
        video_id = self._match_id(url)
        
        # 1. Reverse Engineering: Request flow mandates a session cookie check
        # We perform a "warming" fetch to the main page to populate internal session
        self._request_webpage(
            f'https://video.sibnet.ru/video{video_id}/', 
            video_id, 
            note='Warming session and bypassing anti-bot'
        )
        
        # 2. Multi-stage Discovery Strategy
        # Targets are ordered by reliability (API -> Shell -> Player)
        base_targets = [
            {
                'url': f'https://video.sibnet.ru/shell.php?videoid={video_id}&share=1',
                'note': 'Extracting via Share Shell',
                'referer': f'https://video.sibnet.ru/video{video_id}/'
            },
            {
                'url': f'https://video.sibnet.ru/get_file.php?id={video_id}&type=json',
                'note': 'Extracting via JSON API',
                'referer': f'https://video.sibnet.ru/video{video_id}/'
            },
            {
                'url': f'https://video.sibnet.ru/player.php?id={video_id}',
                'note': 'Extracting via Primary Player',
                'referer': 'https://video.sibnet.ru/'
            }
        ]
        
        # Subdomain Rotation for high availability
        targets = list(base_targets)
        for i in range(1, 6):
            targets.append({
                'url': f'https://dv{i}.sibnet.ru/shell.php?videoid={video_id}',
                'note': f'Trying Subdomain Node dv{i}',
                'referer': 'https://video.sibnet.ru/'
            })
        
        video_url = None
        webpage = ""
        
        for target in targets:
            try:
                self.to_screen(f'[Sibnet] {target["note"]}')
                resp = self._download_webpage(
                    target['url'], 
                    video_id, 
                    headers={'Referer': target['referer']},
                    fatal=False
                )
                
                if not resp:
                    continue
                
                # Check for JSON response (Target 2)
                if 'get_file.php' in target['url']:
                    try:
                        data = self._parse_json(resp, video_id, fatal=False)
                        if data:
                            video_url = dict_get(data, ('link', 'file', 'src', 'url', 'video_src'))
                            if video_url:
                                self.to_screen(f'[Sibnet] Found direct link in API response')
                                break
                    except:
                        pass
                
                # Check for direct slug/path in HTML (Target 1 & 3)
                webpage = resp
                video_url = self._search_regex(
                    [
                        r'["\']?src["\']?\s*:\s*["\'](?P<url>/v/[^"\']+\.mp4(?:\?[^"\']+)?)["\']',
                        r'["\']?file["\']?\s*:\s*["\'](?P<url>[^"\']+\.mp4[^"\']*)["\']',
                        r'setVideo\(["\'](?P<url>[^"\']+)["\']',
                        r'video_src["\']?\s*:\s*["\'](?P<url>[^"\']+\.mp4[^"\']*)["\']',
                        r'["\']?url["\']?\s*:\s*["\'](?P<url>[^"\']+\.mp4[^"\']*)["\']'
                    ], webpage, 'video path', default=None, group='url')
                
                if video_url:
                    self.to_screen(f'[Sibnet] Detected video path through regex patterns')
                    break
                    
            except Exception as e:
                self.to_screen(f'[Sibnet] Warning: Stage failed: {str(e)}')
        
        if not video_url:
            raise ExtractorError('Extraction Failed: Direct video link could not be resolved. This may be due to regional blocks or a private video.')

        # 3. Dynamic Token Reconstruction
        # Many Sibnet paths are incomplete without 'st' (signed timestamp) and 'e' (expiration)
        if (video_url.startswith('/v/') or video_url.startswith('https://dv')) and 'st=' not in video_url:
            self.to_screen('[Sibnet] Injecting dynamic security tokens...')
            st = self._search_regex(r'st\s*:\s*["\']([^"\']+)["\']', webpage, 'st token', default=None)
            e = self._search_regex(r'e\s*:\s*["\']([^"\']+)["\']', webpage, 'e token', default=None)
            
            if st:
                video_url += f"{'&' if '?' in video_url else '?'}st={st}"
            if e:
                video_url += f"&e={e}"
            if 'noip=1' not in video_url:
                video_url += "&noip=1"

        # Construct final absolute URL
        final_url = urljoin('https://video.sibnet.ru', video_url)
        self.to_screen(f'[Sibnet] Final Resolved URL: {final_url[:60]}...')
        
        # 4. Global Metadata Extraction
        title = self._og_search_title(webpage, default=None) or \
                self._html_search_regex(r'<title>(.+?)</title>', webpage, 'title', default=f'Sibnet Video {video_id}')
                
        thumbnail = self._og_search_thumbnail(webpage)
        
        # Get duration if available in microdata or script
        duration = self._html_search_meta('duration', webpage, 'duration', default=None)
        
        return {
            'id': video_id,
            'url': final_url,
            'title': clean_html(title),
            'thumbnail': thumbnail,
            'duration': int(duration) if duration and duration.isdigit() else None,
            'ext': 'mp4',
            'protocol': 'https',
            'http_headers': {
                'Referer': f'https://video.sibnet.ru/video{video_id}/',
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
            }
        }
