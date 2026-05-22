import React, { useEffect, useState, useRef } from 'react';
import { 
  Play, Pause, Volume2, SkipBack, SkipForward, RotateCcw, 
  Video as VideoIcon, Info, FastForward, Eraser, X, Sparkles, Loader2,
  Eye, EyeOff, Type, Maximize, Minimize
} from 'lucide-react';

interface VideoPreviewProps {
  videoUrl: string;
  dubbedAudioUrl?: string | null;
  isPlaying: boolean;
  currentTime: number;
  duration: number;
  volume: number;
  playbackRate: number;
  videoFileName?: string;
  onTogglePlay: () => void;
  onSeek: (time: number) => void;
  onSkipForward: () => void;
  onSkipBackward: () => void;
  onVolumeChange: (volume: number) => void;
  onPlaybackRateChange: (rate: number) => void;
  onReset: () => void;
  videoRef: React.RefObject<HTMLVideoElement>;
  audioRef: React.RefObject<HTMLAudioElement>;
  showSubtitles?: boolean;
  onToggleSubtitles?: () => void;
  subtitleSettings?: {
    font: string;
    size: number;
    color: string;
    bgColor: string;
  };
  currentTranscript?: {
    translatedText: string;
  };
}

export const VideoPreview: React.FC<VideoPreviewProps> = ({
  videoUrl,
  dubbedAudioUrl,
  isPlaying,
  currentTime,
  duration,
  volume,
  playbackRate,
  videoFileName,
  onTogglePlay,
  onSeek,
  onSkipForward,
  onSkipBackward,
  onVolumeChange,
  onPlaybackRateChange,
  onReset,
  videoRef,
  audioRef,
  showSubtitles = true,
  onToggleSubtitles,
  subtitleSettings = {
    font: 'Inter',
    size: 24,
    color: '#ffffff',
    bgColor: 'rgba(0,0,0,0.5)'
  },
  currentTranscript
}) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const [isFullScreen, setIsFullScreen] = useState(false);
  const [isWaiting, setIsWaiting] = useState(false);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    const handleWaiting = () => setIsWaiting(true);
    const handlePlaying = () => setIsWaiting(false);
    const handleCanPlay = () => setIsWaiting(false);

    video.addEventListener('waiting', handleWaiting);
    video.addEventListener('playing', handlePlaying);
    video.addEventListener('canplay', handleCanPlay);

    return () => {
      video.removeEventListener('waiting', handleWaiting);
      video.removeEventListener('playing', handlePlaying);
      video.removeEventListener('canplay', handleCanPlay);
    };
  }, [videoRef.current]);

  useEffect(() => {
    const handleFullScreenChange = () => {
      setIsFullScreen(!!document.fullscreenElement);
    };

    document.addEventListener('fullscreenchange', handleFullScreenChange);
    return () => document.removeEventListener('fullscreenchange', handleFullScreenChange);
  }, []);

  const toggleFullScreen = () => {
    if (!containerRef.current) return;

    if (!document.fullscreenElement) {
      containerRef.current.requestFullscreen().catch(err => {
        console.error(`Error attempting to enable full-screen mode: ${err.message}`);
      });
    } else {
      document.exitFullscreen();
    }
  };

  useEffect(() => {
    if (videoRef.current) {
      videoRef.current.playbackRate = playbackRate;
    }
    if (audioRef.current) {
      audioRef.current.playbackRate = playbackRate;
    }
  }, [playbackRate, videoUrl, dubbedAudioUrl]);

  // Audio Ducking Logic
  useEffect(() => {
    if (videoRef.current) {
      if (dubbedAudioUrl && currentTranscript) {
        // Duck the video volume to 20% of the target volume when dubbing is active
        videoRef.current.volume = volume * 0.2;
      } else {
        // Restore normal volume
        videoRef.current.volume = volume;
      }
    }
    if (audioRef.current) {
      audioRef.current.volume = volume;
    }
  }, [currentTime, currentTranscript, volume, dubbedAudioUrl]);

  const formatTime = (time: number) => {
    const mins = Math.floor(time / 60);
    const secs = Math.floor(time % 60);
    return `${mins}:${secs.toString().padStart(2, '0')}`;
  };

  return (
    <div className="space-y-6">
      <div 
        ref={containerRef}
        className={`relative group overflow-hidden bg-black shadow-[0_0_100px_rgba(0,0,0,1)] ring-1 ring-white/10 transition-all duration-300 ${isFullScreen ? 'rounded-0 w-screen h-screen flex items-center justify-center' : 'rounded-[2rem]'}`}
      >
        <video 
          ref={videoRef}
          src={videoUrl} 
          className={`${isFullScreen ? 'max-h-full max-w-full' : 'w-full aspect-video'} object-contain pointer-events-none`}
          muted={false}
          referrerPolicy="no-referrer"
          playsInline
        />

        {/* Loading Overlay */}
        {isWaiting && (
          <div className="absolute inset-0 flex items-center justify-center bg-black/20 backdrop-blur-[2px] z-30">
            <div className="flex flex-col items-center gap-4">
              <Loader2 className="w-12 h-12 text-orange-500 animate-spin" />
              <span className="text-xs font-black text-white uppercase tracking-[0.2em] drop-shadow-lg">Buffering...</span>
            </div>
          </div>
        )}
        
        {/* Subtitle Overlay */}
        {showSubtitles && currentTranscript && (
          <div className="absolute bottom-24 left-0 right-0 flex justify-center px-12 pointer-events-none z-20">
            <div 
              className="px-4 py-2 rounded-lg text-center shadow-xl"
              style={{
                fontFamily: subtitleSettings.font,
                fontSize: `${subtitleSettings.size}px`,
                color: subtitleSettings.color,
                backgroundColor: subtitleSettings.bgColor,
                maxWidth: '80%',
                lineHeight: '1.4'
              }}
            >
              {currentTranscript.translatedText}
            </div>
          </div>
        )}

        {dubbedAudioUrl && (
          <audio ref={audioRef} src={dubbedAudioUrl} className="hidden" />
        )}
        
        {/* Preview Badge */}
        <div className="absolute top-6 left-6 flex items-center gap-2 px-3 py-1.5 bg-orange-600/90 backdrop-blur-md rounded-full border border-white/20 shadow-xl z-10">
          <div className="w-1.5 h-1.5 bg-white rounded-full animate-pulse" />
          <span className="text-[10px] font-black text-white uppercase tracking-[0.2em]">
            {dubbedAudioUrl ? 'Dubbed Result' : 'Video Preview'}
          </span>
        </div>

        {/* Reset Button */}
        <button 
          onClick={onReset}
          className="absolute top-6 right-6 p-3 bg-black/40 hover:bg-red-600/80 backdrop-blur-md rounded-full border border-white/10 text-white/60 hover:text-white transition-all duration-300 z-10 group/reset"
          title="Change Video"
        >
          <RotateCcw className="w-4 h-4 group-hover:rotate-[-45deg] transition-transform" />
        </button>
        
        {/* Custom Player Controls */}
        <div className="absolute bottom-0 left-0 right-0 bg-gradient-to-t from-black/95 via-black/60 to-transparent p-8 opacity-0 group-hover:opacity-100 transition-all duration-300 translate-y-2 group-hover:translate-y-0">
          <div className="flex items-center gap-4 mb-6">
            <span className="text-xs font-black font-mono text-white/40 w-12 text-right">{formatTime(currentTime)}</span>
            <div className="flex-1 h-1.5 bg-white/10 rounded-full relative group/progress cursor-pointer">
              <div 
                className="absolute top-0 left-0 h-full bg-orange-600 rounded-full shadow-[0_0_15px_rgba(234,88,12,0.5)]" 
                style={{ width: `${(currentTime / duration) * 100}%` }}
              />
              <input 
                type="range"
                min="0"
                max={duration || 0}
                step="0.1"
                value={currentTime}
                onChange={(e) => onSeek(parseFloat(e.target.value))}
                className="absolute inset-0 w-full h-full opacity-0 cursor-pointer"
              />
            </div>
            <span className="text-xs font-black font-mono text-white/40 w-12">{formatTime(duration)}</span>
          </div>

          <div className="flex items-center justify-between">
            <div className="flex items-center gap-6">
              <div className="flex items-center gap-3">
                <button 
                  onClick={onToggleSubtitles}
                  className={`p-2 rounded-full transition-all ${showSubtitles ? 'text-orange-500' : 'text-white/20'}`}
                  title={showSubtitles ? "Hide Subtitles" : "Show Subtitles"}
                >
                  <Type className="w-5 h-5" />
                </button>
                <div className="w-px h-6 bg-white/10 mx-1" />
                <button 
                  onClick={onSkipBackward}
                  className="flex items-center gap-1.5 px-3 py-2 rounded-full hover:bg-white/10 transition-colors text-white/60 hover:text-white"
                  title="Skip backward 10s"
                >
                  <SkipBack className="w-4 h-4" />
                  <span className="text-[10px] font-black uppercase tracking-widest">-10s</span>
                </button>
                <button 
                  onClick={onTogglePlay} 
                  className="w-12 h-12 rounded-full bg-white text-black flex items-center justify-center hover:scale-110 transition-transform active:scale-95 shadow-xl"
                >
                  {isPlaying ? <Pause className="w-6 h-6 fill-current" /> : <Play className="w-6 h-6 fill-current ml-1" />}
                </button>
                <button 
                  onClick={onSkipForward}
                  className="flex items-center gap-1.5 px-3 py-2 rounded-full hover:bg-white/10 transition-colors text-white/60 hover:text-white"
                  title="Skip forward 10s"
                >
                  <span className="text-[10px] font-black uppercase tracking-widest">+10s</span>
                  <SkipForward className="w-4 h-4" />
                </button>
              </div>
              <div className="flex items-center gap-3 group/vol">
                <Volume2 className="w-5 h-5 text-white/40" />
                <input 
                  type="range" min="0" max="1" step="0.1" value={volume}
                  onChange={(e) => onVolumeChange(parseFloat(e.target.value))}
                  className="w-24 h-1 bg-white/10 rounded-full appearance-none cursor-pointer accent-white"
                />
              </div>
              <div className="flex flex-col gap-1 group/speed">
                <div className="flex items-center gap-1.5 ml-1">
                  <FastForward className="w-3 h-3 text-white/20" />
                  <span className="text-[8px] font-black text-white/20 uppercase tracking-widest">Speed</span>
                </div>
                <div className="flex items-center gap-1 bg-white/5 p-1 rounded-xl border border-white/10 backdrop-blur-md">
                  {[0.5, 1, 1.5, 2].map((speed) => (
                    <button
                      key={speed}
                      onClick={() => onPlaybackRateChange(speed)}
                      className={`px-2.5 py-1.5 rounded-lg text-[9px] font-black transition-all ${
                        playbackRate === speed 
                          ? 'bg-orange-600 text-white shadow-[0_0_15px_rgba(234,88,12,0.4)]' 
                          : 'text-white/40 hover:text-white hover:bg-white/5'
                      }`}
                    >
                      {speed}x
                    </button>
                  ))}
                </div>
              </div>
            </div>
            <div className="flex items-center gap-3 px-4 py-2 bg-black/40 rounded-full backdrop-blur-md border border-white/10">
              <button 
                onClick={toggleFullScreen}
                className="p-1 hover:text-orange-500 transition-colors"
                title={isFullScreen ? "Exit Full Screen" : "Full Screen"}
              >
                {isFullScreen ? <Minimize className="w-4 h-4" /> : <Maximize className="w-4 h-4" />}
              </button>
              <div className="w-px h-4 bg-white/10 mx-1" />
              <VideoIcon className="w-3 h-3 text-orange-500" />
              <span className="text-[10px] font-black text-white/40 uppercase tracking-widest truncate max-w-[150px]">
                {videoFileName || 'Recorded Video'}
              </span>
            </div>
          </div>
        </div>
      </div>

      {/* Video Info Cards */}
      {!dubbedAudioUrl && (
        <div className="grid grid-cols-3 gap-4">
          <div className="p-4 rounded-2xl bg-white/5 border border-white/10 flex flex-col gap-1">
            <span className="text-[9px] font-black text-white/20 uppercase tracking-widest">Duration</span>
            <span className="text-sm font-bold text-white/80">{formatTime(duration)}</span>
          </div>
          <div className="p-4 rounded-2xl bg-white/5 border border-white/10 flex flex-col gap-1">
            <span className="text-[9px] font-black text-white/20 uppercase tracking-widest">Status</span>
            <span className="text-sm font-bold text-orange-500">Ready to Dub</span>
          </div>
          <div className="p-4 rounded-2xl bg-white/5 border border-white/10 flex flex-col gap-1">
            <span className="text-[9px] font-black text-white/20 uppercase tracking-widest">Source</span>
            <span className="text-sm font-bold text-white/80 truncate">{videoFileName ? 'Upload' : 'Camera'}</span>
          </div>
        </div>
      )}
    </div>
  );
};
