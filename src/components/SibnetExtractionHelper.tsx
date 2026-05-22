import React, { useEffect, useRef, useState, useCallback } from 'react';

/**
 * Client-side Sibnet video extractor using an iframe.
 * Handles CORS and WAF by running in the user's browser.
 */
export const SibnetExtractionHelper = ({ 
    videoUrl, 
    onExtracted 
}: { 
    videoUrl: string, 
    onExtracted: (url: string) => void 
}) => {
    const iframeRef = useRef<HTMLIFrameElement>(null);
    const [status, setStatus] = useState<'loading' | 'extracting' | 'success' | 'error'>('loading');

    useEffect(() => {
        // Message handler to receive URL from iframe
        const handleMessage = (event: MessageEvent) => {
            if (event.data && event.data.type === 'SIBNET_URL_FOUND') {
                setStatus('success');
                onExtracted(event.data.url);
            }
        };

        window.addEventListener('message', handleMessage);
        return () => window.removeEventListener('message', handleMessage);
    }, [onExtracted]);

    useEffect(() => {
        if (!videoUrl) return;

        // Logic executed inside the iframe to extract the URL
        const extractionScript = `
            (function() {
                // Find all scripts and check for player params
                const scripts = document.querySelectorAll('script');
                for (const s of scripts) {
                    const match = s.textContent.match(/player\\.src\\s*\\(\\s*\\[\\s*\\{\\s*src:\\s*["']([^"']+\\.mp4[^"']*)["']/i);
                    if (match && match[1]) {
                        const absolute = match[1].startsWith('/') ? 'https://video.sibnet.ru' + match[1] : match[1];
                        if (absolute.includes('st=')) {
                            window.parent.postMessage({ type: 'SIBNET_URL_FOUND', url: absolute }, '*');
                            return;
                        }
                    }
                }
                
                // Fallback: look for video elements
                const video = document.querySelector('video');
                if (video && video.src && video.src.includes('st=')) {
                     window.parent.postMessage({ type: 'SIBNET_URL_FOUND', url: video.src }, '*');
                }
            })();
        `;

        if (iframeRef.current) {
            // Note: This relies on Sibnet allowing embedding via iframe which is usually the case for shell.php
            // We load the shell page which is the most reliable for extraction
            const videoIdMatch = videoUrl.match(/(?:video|videoid=)(\d+)/i) || videoUrl.match(/video(\d{5,8})/);
            const videoId = videoIdMatch ? videoIdMatch[1] : null;
            
            if (videoId) {
                iframeRef.current.src = `https://video.sibnet.ru/shell.php?videoid=${videoId}`;
                // Inject the script after load
                iframeRef.current.onload = () => {
                    if (iframeRef.current) {
                        try {
                            iframeRef.current.contentWindow?.eval(extractionScript);
                        } catch (e) {
                            console.error("Iframe extraction failed (CORS likely):", e);
                            setStatus('error');
                        }
                    }
                };
            }
        }
    }, [videoUrl]);

    return (
        <div className="hidden">
            <iframe 
                ref={iframeRef} 
                title="Sibnet Extractor"
                className="w-0 h-0 border-none"
                sandbox="allow-scripts allow-same-origin"
            />
            {status === 'loading' && <p>Ekstraksiyon baslatiliyor...</p>}
            {status === 'error' && <p>Ekstraksiyon hatasi.</p>}
        </div>
    );
};
