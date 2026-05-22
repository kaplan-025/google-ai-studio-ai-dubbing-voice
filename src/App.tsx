import React, { useState, useRef, useEffect } from 'react';
import { useDropzone } from 'react-dropzone';
import { GoogleGenAI, Modality, Type } from "@google/genai";
import { 
  Play, Pause, Upload, Languages, Loader2, Volume2, 
  CheckCircle2, AlertCircle, Download, Settings2, 
  User, Users, FastForward, Info, RotateCcw, Camera, Video,
  SkipBack, SkipForward, Save, FolderOpen, Sparkles, Trash2,
  Search, Clock, Mic2
} from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { VideoPreview } from './components/VideoPreview';
import { SibnetExtractionHelper } from './components/SibnetExtractionHelper';
import { FFmpeg } from '@ffmpeg/ffmpeg';
import { fetchFile, toBlobURL } from '@ffmpeg/util';

// Initialize Gemini
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY || '' });

interface TranscriptSegment {
  startTime: number;
  endTime: number;
  text: string;
  translatedText: string;
  speaker: string;
  speakerGender?: 'Male' | 'Female' | 'Unknown';
}

interface Mask {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
  startTime: number;
  endTime: number;
  originalText?: string;
  translatedText?: string;
}

interface BatchItem {
  id: string;
  file: File;
  url: string;
  status: 'pending' | 'processing' | 'completed' | 'error';
  progress: number;
  error?: string;
  dubbedAudioUrl?: string | null;
  transcript?: TranscriptSegment[];
  masks?: Mask[];
}

interface GeminiErrorDetails {
  message: string;
  code?: string;
  status?: number;
  troubleshooting: string[];
}

interface CustomVoiceProfile {
  id: string;
  name: string;
  data: string;
  description: string;
}

const parseGeminiError = (error: any): GeminiErrorDetails => {
  const msg = error?.message || String(error);
  const lowerMsg = msg.toLowerCase();
  
  if (msg.includes('429') || lowerMsg.includes('rate limit') || lowerMsg.includes('resource_exhausted') || lowerMsg.includes('quota')) {
    const isHardQuota = (lowerMsg.includes('resource_exhausted') || lowerMsg.includes('quota')) && lowerMsg.includes('billing');
    return {
      message: isHardQuota ? "Daily Quota Expired (429)" : "Rate Limit / Quota Buffering (429)",
      code: isHardQuota ? "QUOTA_ERROR" : "RATE_LIMIT",
      troubleshooting: isHardQuota ? [
        "Your Google AI Studio daily quota has been fully exhausted.",
        "It will reset tomorrow, or you can switch to a paid tier.",
        "Check your plan details here: https://aistudio.google.com/app/plan"
      ] : [
        "The system has temporarily reached its capacity.",
        "Auto-retry is active. Please stay on this page.",
        "Large videos or frequent requests can trigger this. Waiting for cooldown..."
      ]
    };
  }
  
  if (msg.includes('401') || lowerMsg.includes('invalid api key') || lowerMsg.includes('unauthorized')) {
    return {
      message: "Authentication Error (401)",
      code: "AUTH_ERROR",
      troubleshooting: [
        "Check if your GEMINI_API_KEY is correct in the environment variables.",
        "Ensure your API key has not expired or been deactivated.",
        "Verify that you are using the correct project in Google AI Studio."
      ]
    };
  }

  if (msg.includes('403') || lowerMsg.includes('permission denied')) {
    return {
      message: "Permission Denied (403)",
      code: "PERMISSION_ERROR",
      troubleshooting: [
        "Check if your API key has access to the Gemini models.",
        "Ensure billing is enabled if required for the specific model.",
        "Verify that the Gemini API is enabled in your Google Cloud project."
      ]
    };
  }

  if (lowerMsg.includes('safety') || lowerMsg.includes('blocked')) {
    return {
      message: "Safety Filter Triggered",
      code: "SAFETY_ERROR",
      troubleshooting: [
        "The content of the video might have triggered Gemini's safety filters.",
        "Try a video with less sensitive content.",
        "Check the safety settings in your API configuration if possible.",
        "Ensure the video does not contain prohibited content according to Google's policies."
      ]
    };
  }

  if (lowerMsg.includes('quota') || msg.includes('429')) {
    return {
      message: "Quota Exceeded",
      code: "QUOTA_ERROR",
      troubleshooting: [
        "You have reached your daily or monthly API quota.",
        "Check your Google AI Studio dashboard for usage details.",
        "Wait for the quota to reset (usually at midnight Pacific Time).",
        "Consider using a different API key or upgrading your plan."
      ]
    };
  }

  if (lowerMsg.includes('model not found') || lowerMsg.includes('503') || lowerMsg.includes('overloaded')) {
    return {
      message: "Service Unavailable (503)",
      code: "SERVICE_ERROR",
      troubleshooting: [
        "The Gemini service might be temporarily overloaded or down.",
        "Wait a few seconds and try again.",
        "Check the Google Cloud Status dashboard for any ongoing incidents."
      ]
    };
  }

  return {
    message: "Gemini API Error",
    troubleshooting: [
      "Check your internet connection.",
      "Try refreshing the page.",
      "If the problem persists, the Gemini service might be temporarily down.",
      "Verify that your video file is not corrupted."
    ]
  };
};

const callGeminiWithRetry = async (fn: () => Promise<any>, maxRetries = 5, initialDelay = 5000, onRetry?: (msg: string) => void) => {
  let lastError: any;
  const API_TIMEOUT = 120000; // 2 dakikalık sert zaman aşımı

  for (let i = 0; i <= maxRetries; i++) {
    try {
      // PROMISE.RACE ile zaman aşımı koruması
      const result = await Promise.race([
        fn(),
        new Promise((_, reject) => 
          setTimeout(() => reject(new Error('GEMINI_TIMEOUT: API did not respond in time.')), API_TIMEOUT)
        )
      ]);
      return result;
    } catch (err: any) {
      lastError = err;
      const msg = err?.message || String(err);
      const lowerMsg = msg.toLowerCase();
      
      const isRateLimit = msg.includes('429') || lowerMsg.includes('rate limit');
      const isQuota = lowerMsg.includes('resource_exhausted') || lowerMsg.includes('quota');
      const isServiceError = msg.includes('503') || lowerMsg.includes('overloaded') || lowerMsg.includes('deadline_exceeded');
      
      if ((isRateLimit || isQuota || isServiceError) && i < maxRetries) {
        // Significantly longer delay for Quota errors (Resource Exhausted)
        // Free tier often has tight TPM (Tokens Per Minute) and RPM (Requests Per Minute)
        const baseDelay = isQuota ? 30000 : (isRateLimit ? 10000 : initialDelay);
        const delay = baseDelay * Math.pow(2, i) + Math.random() * 5000;
        
        const retryMsg = `Rate limit hit (${isQuota ? 'Quota' : 'Rate'}). Retrying in ${Math.round(delay/1000)}s... (Attempt ${i + 1}/${maxRetries})`;
        console.warn(retryMsg);
        if (onRetry) onRetry(retryMsg);
        
        await new Promise(resolve => setTimeout(resolve, delay));
        continue;
      }
      throw err;
    }
  }
  throw lastError;
};

export default function App() {
  // Media State
  const [videoFile, setVideoFile] = useState<File | null>(null);
  const [videoUrl, setVideoUrl] = useState<string | null>(null);
  const [dubbedAudioUrl, setDubbedAudioUrl] = useState<string | null>(null);
  const [transcript, setTranscript] = useState<TranscriptSegment[]>([]);
  const [isProcessing, setIsProcessing] = useState(false);
  const [processingStep, setProcessingStep] = useState<'idle' | 'analyzing' | 'optimizing' | 'dubbing'>('idle');
  const [status, setStatus] = useState('');
  const [progress, setProgress] = useState(0);
  const [stepProgress, setStepProgress] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [errorDetails, setErrorDetails] = useState<GeminiErrorDetails | null>(null);
  const [processingLogs, setProcessingLogs] = useState<{message: string, timestamp: number, type: 'info' | 'success' | 'warning' | 'error'}[]>([]);
  const [isMuxing, setIsMuxing] = useState(false);
  const [isRecording, setIsRecording] = useState(false);
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [playbackRate, setPlaybackRate] = useState(1);
  const [sourceLang, setSourceLang] = useState('Auto-detect');
  const [targetLang, setTargetLang] = useState('Turkish');
  const [maxAcceleration, setMaxAcceleration] = useState(1.4);
  const [avoidOverlap, setAvoidOverlap] = useState(true);
  const [literalizeNumbers, setLiteralizeNumbers] = useState(true);
  const [rightPanel, setRightPanel] = useState<'transcript' | 'settings'>('transcript');
  const [outputFormat, setOutputFormat] = useState('webm');
  const [outputCodec, setOutputCodec] = useState('vp9');
  const [autoCloneVoices, setAutoCloneVoices] = useState(false);
  const [speakerVoices, setSpeakerVoices] = useState<Record<string, string>>({
    'SPEAKER_01': 'Kore',
    'SPEAKER_02': 'Fenrir',
    'SPEAKER_03': 'Zephyr',
    'SPEAKER_04': 'Puck',
  });
  const [followVideo, setFollowVideo] = useState(true);
  const [activeSegmentIndex, setActiveSegmentIndex] = useState<number | null>(null);
  const [showSubtitles, setShowSubtitles] = useState(true);
  const [videoSource, setVideoSource] = useState<'upload' | 'camera' | 'link'>('upload');
  const [videoUrlInput, setVideoUrlInput] = useState('');
  const [videoMetadata, setVideoMetadata] = useState<{title?: string, description?: string, date?: string} | null>(null);
  const [isExtracting, setIsExtracting] = useState(false);
  const [activeMainTab, setActiveMainTab] = useState<'process' | 'explore'>('process');
  const [youtubeSearchQuery, setYoutubeSearchQuery] = useState('');
  const [youtubeSearchResults, setYoutubeSearchResults] = useState<any[]>([]);
  const [isSearching, setIsSearching] = useState(false);
  const [isSnifferActive, setIsSnifferActive] = useState(false);
  const [sniffedUrl, setSniffedUrl] = useState<string | null>(null);
  const [snifferStatus, setSnifferStatus] = useState<'idle' | 'waiting' | 'found'>('idle');
  const [sibnetEscalationUrl, setSibnetEscalationUrl] = useState<string | null>(null);
  const [downloadProgress, setDownloadProgress] = useState(0);
  const [cameraStream, setCameraStream] = useState<MediaStream | null>(null);
  const [isRecordingCamera, setIsRecordingCamera] = useState(false);
  const [isTranslating, setIsTranslating] = useState(false);
  const [volume, setVolume] = useState(1);
  const [isRecordingMic, setIsRecordingMic] = useState(false);
  const [micStream, setMicStream] = useState<MediaStream | null>(null);
  const [customVoiceProfiles, setCustomVoiceProfiles] = useState<CustomVoiceProfile[]>([]);
  const [pendingVoiceFile, setPendingVoiceFile] = useState<File | null>(null);
  const [pendingVoiceName, setPendingVoiceName] = useState('');
  const cameraPreviewRef = useRef<HTMLVideoElement>(null);
  const recordedChunksRef = useRef<Blob[]>([]);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const micRecorderRef = useRef<MediaRecorder | null>(null);
  const cancelRef = useRef<boolean>(false);
  const ffmpegRef = useRef<FFmpeg | null>(null);
  const [metrics, setMetrics] = useState({
    startTime: null as number | null,
    elapsedTime: 0,
    apiCalls: 0,
    bytesProcessed: 0
  });
  const [subtitleFont, setSubtitleFont] = useState('Inter');
  const [subtitleSize, setSubtitleSize] = useState(24);
  const [subtitleColor, setSubtitleColor] = useState('#ffffff');
  const [subtitleBgColor, setSubtitleBgColor] = useState('#000000');
  const [subtitleBgOpacity, setSubtitleBgOpacity] = useState(0.5);
  const transcriptContainerRef = useRef<HTMLDivElement>(null);
  const activeSegmentRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const videoRef = useRef<HTMLVideoElement>(null);
  const audioRef = useRef<HTMLAudioElement>(null);

  const STORAGE_KEY = 'sonitranslate_preferences';

  // Load preferences on mount
  useEffect(() => {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved) {
      try {
        const prefs = JSON.parse(saved);
        if (prefs.sourceLang) setSourceLang(prefs.sourceLang);
        if (prefs.targetLang) setTargetLang(prefs.targetLang);
        if (prefs.maxAcceleration) setMaxAcceleration(prefs.maxAcceleration);
        if (prefs.avoidOverlap !== undefined) setAvoidOverlap(prefs.avoidOverlap);
        if (prefs.literalizeNumbers !== undefined) setLiteralizeNumbers(prefs.literalizeNumbers);
        if (prefs.speakerVoices) setSpeakerVoices(prefs.speakerVoices);
        if (prefs.customVoiceProfiles) setCustomVoiceProfiles(prefs.customVoiceProfiles);
        if (prefs.outputFormat) setOutputFormat(prefs.outputFormat);
        if (prefs.outputCodec) setOutputCodec(prefs.outputCodec);
        if (prefs.showSubtitles !== undefined) setShowSubtitles(prefs.showSubtitles);
        if (prefs.subtitleFont) setSubtitleFont(prefs.subtitleFont);
        if (prefs.subtitleSize) setSubtitleSize(prefs.subtitleSize);
        if (prefs.subtitleColor) setSubtitleColor(prefs.subtitleColor);
        if (prefs.subtitleBgColor) setSubtitleBgColor(prefs.subtitleBgColor);
        if (prefs.subtitleBgOpacity !== undefined) setSubtitleBgOpacity(prefs.subtitleBgOpacity);
        if (prefs.autoCloneVoices !== undefined) setAutoCloneVoices(prefs.autoCloneVoices);
      } catch (e) {
        console.error("Failed to load preferences", e);
      }
    }
  }, []);

  // Save preferences on change
  useEffect(() => {
    const prefs = {
      sourceLang,
      targetLang,
      maxAcceleration,
      avoidOverlap,
      literalizeNumbers,
      speakerVoices,
      customVoiceProfiles,
      outputFormat,
      outputCodec,
      showSubtitles,
      subtitleFont,
      subtitleSize,
      subtitleColor,
      subtitleBgColor,
      subtitleBgOpacity,
      autoCloneVoices
    };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs));
  }, [sourceLang, targetLang, maxAcceleration, avoidOverlap, literalizeNumbers, speakerVoices, customVoiceProfiles, outputFormat, outputCodec, showSubtitles, subtitleFont, subtitleSize, subtitleColor, subtitleBgColor, subtitleBgOpacity, autoCloneVoices]);

  // Message listener for sniffer iframe
  useEffect(() => {
    const handleMessage = (event: MessageEvent) => {
      if (event.data?.type === 'SIBNET_SNIFFED' && event.data?.url) {
        console.log("Sniffed URL received from iframe:", event.data.url);
        setSniffedUrl(event.data.url);
        setSnifferStatus('found');
        addLog(`Video link captured via Sniffer: ${event.data.url.substring(0, 30)}...`, 'success');
        
        // Update input and start extraction automatically
        setVideoUrlInput(event.data.url);
        // We delay slightly to allow UI feedback
        setTimeout(() => {
          setIsSnifferActive(false);
        }, 1500);
      }
    };

    window.addEventListener('message', handleMessage);
    return () => window.removeEventListener('message', handleMessage);
  }, []);

  const voices = [
    { id: 'Kore', name: 'Female (Warm)', gender: 'Female' },
    { id: 'Zephyr', name: 'Female (Clear)', gender: 'Female' },
    { id: 'Fenrir', name: 'Male (Deep)', gender: 'Male' },
    { id: 'Puck', name: 'Male (Youthful)', gender: 'Male' },
    { id: 'Charon', name: 'Male (Mature)', gender: 'Male' },
    ...customVoiceProfiles.map(p => ({ id: p.id, name: `Clone: ${p.name}`, gender: 'Custom' }))
  ];

  const handleVoiceUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      setPendingVoiceFile(file);
      if (!pendingVoiceName) {
        setPendingVoiceName(file.name.split('.')[0]);
      }
    }
  };

  const initiateCloning = async () => {
    if (!pendingVoiceFile || !pendingVoiceName) return;

    setProcessingStep('analyzing');
    setStatus('Analyzing voice characteristics...');
    setIsProcessing(true);

    try {
      const reader = new FileReader();
      const base64Promise = new Promise<string>((resolve) => {
        reader.onload = () => resolve(reader.result as string);
      });
      reader.readAsDataURL(pendingVoiceFile);
      const base64WithHeader = await base64Promise;
      const base64 = base64WithHeader.split(',')[1];

      // Use Gemini to analyze the voice characteristics - using Lite for efficiency
      const analysis = await callGeminiWithRetry(() => ai.models.generateContent({
        model: "gemini-3.1-flash-lite-preview",
        contents: [
          { inlineData: { data: base64, mimeType: pendingVoiceFile.type } },
          { text: "Analyze this voice sample. Describe the pitch, tone, gender, and unique characteristics in a way that can be used to replicate it. Keep it concise." }
        ]
      }), 5, 5000, (m) => addLog(m, 'warning'));

      const newProfile = {
        id: `custom_${Date.now()}`,
        name: pendingVoiceName,
        data: base64WithHeader,
        description: analysis.text
      };

      setCustomVoiceProfiles([...customVoiceProfiles, newProfile]);
      setPendingVoiceFile(null);
      setPendingVoiceName('');
      setStatus('Voice profile cloned successfully!');
    } catch (err) {
      console.error("Cloning failed:", err);
      const details = parseGeminiError(err);
      setError(details.message);
      setErrorDetails(details);
      addLog(`Voice cloning failed: ${details.message}`, 'error');
    } finally {
      setIsProcessing(false);
      setProcessingStep('idle');
    }
  };

  // Handle incoming URL parameters (Bookmarklet support)
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const urlFromParam = params.get('url');
    if (urlFromParam) {
      setVideoSource('link');
      setVideoUrlInput(urlFromParam);
      // Small delay to ensure state is set before triggering extraction
      setTimeout(() => {
        handleExtractLink(urlFromParam);
      }, 500);
      
      // Clean up URL
      window.history.replaceState({}, document.title, window.location.pathname);
    }
  }, []);

  // Auto-translate when target language changes
  useEffect(() => {
    if (transcript.length > 0 && !isTranslating) {
      autoTranslateTranscript();
    }
  }, [targetLang]);

  const autoTranslateTranscript = async () => {
    if (transcript.length === 0) return;
    setIsTranslating(true);
    try {
      const textsToTranslate = transcript.map(s => s.text);
      const response = await callGeminiWithRetry(() => ai.models.generateContent({
        model: "gemini-3.1-flash-lite-preview",
        contents: `Translate the following array of texts into ${targetLang}. Return ONLY a JSON array of strings in the same order.\n\n${JSON.stringify(textsToTranslate)}`,
        config: {
          responseMimeType: "application/json",
          responseSchema: {
            type: Type.ARRAY,
            items: { type: Type.STRING }
          }
        }
      }), 5, 5000, (m) => addLog(m, 'warning'));

      const translatedTexts: string[] = JSON.parse(response.text || '[]');
      if (translatedTexts.length === transcript.length) {
        const newTranscript = transcript.map((s, i) => ({
          ...s,
          translatedText: translatedTexts[i]
        }));
        setTranscript(newTranscript);
      }
    } catch (err) {
      console.error("Auto-translation failed:", err);
      const details = parseGeminiError(err);
      setError(details.message);
      setErrorDetails(details);
    } finally {
      setIsTranslating(false);
    }
  };

  const formatSRTTime = (seconds: number) => {
    const hrs = Math.floor(seconds / 3600);
    const mins = Math.floor((seconds % 3600) / 60);
    const secs = Math.floor(seconds % 60);
    const ms = Math.floor((seconds % 1) * 1000);
    return `${hrs.toString().padStart(2, '0')}:${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')},${ms.toString().padStart(3, '0')}`;
  };

  const downloadTranscript = (format: 'txt' | 'srt' | 'json') => {
    if (transcript.length === 0) return;

    let content = '';
    let mimeType = 'text/plain';
    const extension = format;

    if (format === 'txt') {
      content = transcript.map(s => `[${formatTime(s.startTime)} - ${formatTime(s.endTime)}] ${s.speaker}: ${s.translatedText || s.text}`).join('\n\n');
    } else if (format === 'srt') {
      content = transcript.map((s, i) => {
        const start = formatSRTTime(s.startTime);
        const end = formatSRTTime(s.endTime);
        return `${i + 1}\n${start} --> ${end}\n${s.translatedText || s.text}\n`;
      }).join('\n');
    } else if (format === 'json') {
      content = JSON.stringify(transcript, null, 2);
      mimeType = 'application/json';
    }

    const blob = new Blob([content], { type: mimeType });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `transcript_${Date.now()}.${extension}`;
    a.click();
    URL.revokeObjectURL(url);
    addLog(`Transcript downloaded as ${format.toUpperCase()}`, 'success');
  };

  const languages = [
    'Turkish', 'English', 'Chinese', 'Spanish', 'French', 'German', 'Japanese', 'Russian', 'Arabic', 'Portuguese', 'Italian', 'Korean'
  ];

  const onDrop = (acceptedFiles: File[]) => {
    if (acceptedFiles.length > 0) {
      const file = acceptedFiles[0];
      setVideoFile(file);
      setVideoUrl(URL.createObjectURL(file));
      setDubbedAudioUrl(null);
      setTranscript([]);
      addLog(`Video loaded: ${file.name}`, 'success');
    }
  };

  const { getRootProps, getInputProps, isDragActive } = useDropzone({
    onDrop,
    accept: { 'video/*': [] },
    multiple: true
  } as any);

  const startCamera = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
      setCameraStream(stream);
      if (cameraPreviewRef.current) {
        cameraPreviewRef.current.srcObject = stream;
      }
    } catch (err) {
      console.error("Error accessing camera:", err);
      setError("Could not access camera. Please check permissions.");
    }
  };

  const stopCamera = () => {
    if (cameraStream) {
      cameraStream.getTracks().forEach(track => track.stop());
      setCameraStream(null);
    }
  };

  const startRecordingCamera = () => {
    if (!cameraStream) return;
    recordedChunksRef.current = [];
    
    // Ensure only one audio track is used to avoid MediaRecorder errors
    const audioTracks = cameraStream.getAudioTracks();
    const videoTracks = cameraStream.getVideoTracks();
    const singleTrackStream = new MediaStream();
    if (videoTracks.length > 0) singleTrackStream.addTrack(videoTracks[0]);
    if (audioTracks.length > 0) singleTrackStream.addTrack(audioTracks[0]);

    const recorder = new MediaRecorder(singleTrackStream, { mimeType: 'video/webm' });
    mediaRecorderRef.current = recorder;
    recorder.ondataavailable = (e) => {
      if (e.data.size > 0) recordedChunksRef.current.push(e.data);
    };
    recorder.onstop = () => {
      const blob = new Blob(recordedChunksRef.current, { type: 'video/webm' });
      const file = new File([blob], `camera_record_${Date.now()}.webm`, { type: 'video/webm' });
      setVideoFile(file);
      setVideoUrl(URL.createObjectURL(blob));
      stopCamera();
    };
    recorder.start();
    setIsRecordingCamera(true);
  };

  const stopRecordingCamera = () => {
    if (mediaRecorderRef.current && isRecordingCamera) {
      mediaRecorderRef.current.stop();
      setIsRecordingCamera(false);
    }
  };

  const startMicRecording = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      setMicStream(stream);
      recordedChunksRef.current = [];
      
      // Ensure only one audio track is used
      const audioTracks = stream.getAudioTracks();
      const singleTrackStream = new MediaStream();
      if (audioTracks.length > 0) singleTrackStream.addTrack(audioTracks[0]);

      const recorder = new MediaRecorder(singleTrackStream);
      micRecorderRef.current = recorder;
      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) recordedChunksRef.current.push(e.data);
      };
      recorder.onstop = () => {
        const blob = new Blob(recordedChunksRef.current, { type: 'audio/webm' });
        setDubbedAudioUrl(URL.createObjectURL(blob));
        stream.getTracks().forEach(track => track.stop());
        setMicStream(null);
      };
      recorder.start();
      setIsRecordingMic(true);
      setStatus('Recording your voice...');
    } catch (err) {
      console.error("Error accessing microphone:", err);
      setError("Could not access microphone. Please check permissions.");
    }
  };

  const stopMicRecording = () => {
    if (micRecorderRef.current && isRecordingMic) {
      micRecorderRef.current.stop();
      setIsRecordingMic(false);
      setStatus('Voice recording saved.');
    }
  };

  useEffect(() => {
    const loadFFmpeg = async () => {
      if (!window.crossOriginIsolated) {
        console.warn('Warning: Cross-Origin Isolation is not enabled. FFmpeg may fall back to single-threaded mode.');
        addLog('Turbo Mode (Multi-threading) disabled in preview. Open Shared App URL in a new tab for full speed.', 'warning');
      }
      if (!ffmpegRef.current) {
        try {
          const ffmpeg = new FFmpeg();
          const baseURL = 'https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.12.6/dist/esm';
          await ffmpeg.load({
            coreURL: await toBlobURL(`${baseURL}/ffmpeg-core.js`, 'text/javascript'),
            wasmURL: await toBlobURL(`${baseURL}/ffmpeg-core.wasm`, 'application/wasm'),
          });
          ffmpegRef.current = ffmpeg;
          addLog('FFmpeg engine ready (Turbo Mode)', 'success');
        } catch (err) {
          console.error("FFmpeg load failed:", err);
        }
      }
    };
    loadFFmpeg();
  }, []);

  useEffect(() => {
    if (videoSource === 'camera' && !videoUrl) {
      startCamera();
    } else {
      stopCamera();
    }
    return () => stopCamera();
  }, [videoSource, videoUrl]);

  useEffect(() => {
    let interval: any;
    if (isProcessing && metrics.startTime) {
      interval = setInterval(() => {
        setMetrics(prev => ({
          ...prev,
          elapsedTime: (Date.now() - prev.startTime!) / 1000
        }));
      }, 100);
    }
    return () => clearInterval(interval);
  }, [isProcessing, metrics.startTime]);

  const addLog = (message: string, type: 'info' | 'success' | 'warning' | 'error' = 'info') => {
    setProcessingLogs(prev => [{ message, timestamp: Date.now(), type }, ...prev].slice(0, 50));
  };

  const hexToRgba = (hex: string, opacity: number) => {
    if (!hex.startsWith('#')) return hex;
    const r = parseInt(hex.slice(1, 3), 16);
    const g = parseInt(hex.slice(3, 5), 16);
    const b = parseInt(hex.slice(5, 7), 16);
    return `rgba(${r}, ${g}, ${b}, ${opacity})`;
  };

  const ffmpegMutex = useRef<Promise<any>>(Promise.resolve());
  const runFFmpeg = async <T,>(task: () => Promise<T>): Promise<T> => {
    const previous = ffmpegMutex.current;
    let resolve: any;
    ffmpegMutex.current = new Promise(r => resolve = r);
    await previous;
    try {
      return await task();
    } finally {
      resolve();
    }
  };

  const blobToBase64 = (blob: Blob): Promise<string> => {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onloadend = () => resolve((reader.result as string).split(',')[1]);
      reader.onerror = reject;
      reader.readAsDataURL(blob);
    });
  };

  const getAudioBuffer = async (file: File): Promise<AudioBuffer> => {
    const audioContext = new (window.AudioContext || (window as any).webkitAudioContext)();
    try {
      const arrayBuffer = await file.arrayBuffer();
      try {
        return await audioContext.decodeAudioData(arrayBuffer);
      } catch (decodeErr) {
        console.warn("Native decode failed, trying FFmpeg extraction...", decodeErr);
        addLog('Native audio decoding failed, using FFmpeg fallback...', 'warning');
        
        // Use FFmpeg to extract audio to a format decodeAudioData definitely likes (WAV)
        const base64Wav = await extractAudioFFmpeg(file, 44100);
        const binaryString = atob(base64Wav);
        const wavBuffer = new ArrayBuffer(binaryString.length);
        const uint8Array = new Uint8Array(wavBuffer);
        for (let i = 0; i < binaryString.length; i++) {
          uint8Array[i] = binaryString.charCodeAt(i);
        }
        return await audioContext.decodeAudioData(wavBuffer);
      }
    } finally {
      await audioContext.close();
    }
  };

  const sliceAudioBuffer = async (buffer: AudioBuffer, start: number, end: number, targetSampleRate = 8000): Promise<string> => {
    const duration = Math.min(end - start, buffer.duration - start);
    if (duration <= 0) return "";
    
    const offlineCtx = new OfflineAudioContext(1, Math.ceil(duration * targetSampleRate), targetSampleRate);
    
    const source = offlineCtx.createBufferSource();
    source.buffer = buffer;
    source.connect(offlineCtx.destination);
    source.start(0, start, duration);
    
    const resampledBuffer = await offlineCtx.startRendering();
    const pcmData = resampledBuffer.getChannelData(0);
    const wavBuffer = encodeWAV(pcmData, targetSampleRate);
    return await blobToBase64(new Blob([wavBuffer], { type: 'audio/wav' }));
  };

  const extractAudioNative = async (file: File, targetSampleRate = 16000): Promise<string> => {
    addLog('Extracting audio using native browser API (Ultra Fast)...', 'info');
    
    // Timeout promise to prevent hanging on large files
    const timeout = new Promise<never>((_, reject) => 
      setTimeout(() => reject(new Error('Native extraction timeout')), 60000)
    );

    const extraction = (async () => {
      const audioContext = new (window.AudioContext || (window as any).webkitAudioContext)();
      try {
        const arrayBuffer = await file.arrayBuffer();
        const audioBuffer = await audioContext.decodeAudioData(arrayBuffer);
        
        const offlineCtx = new OfflineAudioContext(1, audioBuffer.duration * targetSampleRate, targetSampleRate);
        const source = offlineCtx.createBufferSource();
        source.buffer = audioBuffer;
        source.connect(offlineCtx.destination);
        source.start();
        
        const resampledBuffer = await offlineCtx.startRendering();
        const pcmData = resampledBuffer.getChannelData(0);
        
        addLog(`Audio extracted: ${resampledBuffer.duration.toFixed(2)}s at ${targetSampleRate}Hz`, 'info');
        
        const wavBuffer = encodeWAV(pcmData, targetSampleRate);
        const base64 = await blobToBase64(new Blob([wavBuffer], { type: 'audio/wav' }));
        
        return base64;
      } finally {
        await audioContext.close();
      }
    })();

    try {
      return await Promise.race([extraction, timeout]);
    } catch (err) {
      addLog('Native extraction failed, falling back to FFmpeg...', 'warning');
      return await extractAudioFFmpeg(file, targetSampleRate);
    }
  };

  const ensureFFmpeg = async () => {
    if (ffmpegRef.current) return ffmpegRef.current;
    
    addLog('Loading FFmpeg engine...', 'info');
    const ffmpeg = new FFmpeg();
    const baseURL = 'https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.12.6/dist/esm';
    await ffmpeg.load({
      coreURL: await toBlobURL(`${baseURL}/ffmpeg-core.js`, 'text/javascript'),
      wasmURL: await toBlobURL(`${baseURL}/ffmpeg-core.wasm`, 'application/wasm'),
    });
    ffmpegRef.current = ffmpeg;
    return ffmpeg;
  };

  const safeDelete = async (ffmpeg: FFmpeg, filename: string) => {
    try {
      await ffmpeg.deleteFile(filename);
    } catch (e) {
      // Ignore errors if file doesn't exist
    }
  };

  const extractAudioFFmpeg = async (file: File, targetSampleRate = 16000): Promise<string> => {
    const ffmpeg = await ensureFFmpeg();
    return await runFFmpeg(async () => {
      // Use fixed names to avoid FS issues with special characters
      const inputName = 'input_file';
      const outputName = 'output.wav';

      try {
        await safeDelete(ffmpeg, inputName);
        await safeDelete(ffmpeg, outputName);
        await ffmpeg.writeFile(inputName, await fetchFile(file));
        
        // Extract audio to WAV
        const exitCode = await ffmpeg.exec([
          '-i', inputName,
          '-ar', targetSampleRate.toString(),
          '-ac', '1',
          '-y', // Overwrite if exists
          outputName
        ]);

        if (exitCode !== 0) {
          throw new Error(`FFmpeg extraction failed with exit code ${exitCode}`);
        }

        const data = await ffmpeg.readFile(outputName);
        if (!data || data.length === 0) {
          throw new Error("Extracted audio data is empty. The video might not have an audio track.");
        }
        const base64 = await blobToBase64(new Blob([data], { type: 'audio/wav' }));
        return base64;
      } finally {
        // Cleanup in finally block to ensure it happens even on error
        await safeDelete(ffmpeg, inputName);
        await safeDelete(ffmpeg, outputName);
      }
    });
  };

  const encodeWAV = (samples: Float32Array, sampleRate: number) => {
    const buffer = new ArrayBuffer(44 + samples.length * 2);
    const view = new DataView(buffer);
    
    const writeString = (offset: number, string: string) => {
      for (let i = 0; i < string.length; i++) {
        view.setUint8(offset + i, string.charCodeAt(i));
      }
    };
    
    writeString(0, 'RIFF');
    view.setUint32(4, 36 + samples.length * 2, true);
    writeString(8, 'WAVE');
    writeString(12, 'fmt ');
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, 1, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * 2, true);
    view.setUint16(32, 2, true);
    view.setUint16(34, 16, true);
    writeString(36, 'data');
    view.setUint32(40, samples.length * 2, true);
    
    let offset = 44;
    for (let i = 0; i < samples.length; i++, offset += 2) {
      const s = Math.max(-1, Math.min(1, samples[i]));
      view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7FFF, true);
    }
    
    return buffer;
  };

  const cloneVoicesFromVideo = async (file: File, segments: TranscriptSegment[]) => {
    addLog(`Initializing native voice extraction for ${segments.length} segments...`, 'info');
    
    const uniqueSpeakers = Array.from(new Set(segments.map(s => s.speaker)));
    const newProfiles: {id: string, name: string, data: string}[] = [];
    const newSpeakerVoices: Record<string, string> = { ...speakerVoices };

    try {
      const audioContext = new (window.AudioContext || (window as any).webkitAudioContext)();
      const arrayBuffer = await file.arrayBuffer();
      let audioBuffer: AudioBuffer;
      
      try {
        audioBuffer = await audioContext.decodeAudioData(arrayBuffer);
      } catch (err) {
        addLog('Native decode failed for voice cloning, using FFmpeg fallback...', 'warning');
        const ffmpegWav = await extractAudioFFmpeg(file, 44100); // High quality for cloning
        const wavBuffer = Uint8Array.from(atob(ffmpegWav), c => c.charCodeAt(0)).buffer;
        audioBuffer = await audioContext.decodeAudioData(wavBuffer);
      }

      for (const speaker of uniqueSpeakers) {
        if (cancelRef.current) break;
        const speakerSegments = segments.filter(s => s.speaker === speaker);
        const bestSegment = speakerSegments.find(s => (s.endTime - s.startTime) >= 3) || speakerSegments[0];
        
        if (!bestSegment) continue;

        const duration = Math.min(bestSegment.endTime - bestSegment.startTime, 5);
        const start = bestSegment.startTime;

        addLog(`Extracting native voice sample for ${speaker}...`, 'info');

        const sampleRate = 24000;
        const offlineCtx = new OfflineAudioContext(1, duration * sampleRate, sampleRate);
        const source = offlineCtx.createBufferSource();
        source.buffer = audioBuffer;
        source.connect(offlineCtx.destination);
        source.start(0, start, duration);
        
        const renderedBuffer = await offlineCtx.startRendering();
        const pcmData = renderedBuffer.getChannelData(0);
        const wavBuffer = encodeWAV(pcmData, sampleRate);
        const base64 = await blobToBase64(new Blob([wavBuffer], { type: 'audio/wav' }));

        const profileId = `custom_${speaker}_${Date.now()}`;
        newProfiles.push({
          id: profileId,
          name: `Auto: ${speaker}`,
          data: `data:audio/wav;base64,${base64}`
        });
        newSpeakerVoices[speaker] = profileId;
      }
      await audioContext.close();
    } catch (err) {
      addLog('Native voice extraction failed. Falling back to default voices.', 'error');
      console.error(err);
    }

    if (newProfiles.length > 0) {
      setCustomVoiceProfiles(prev => [...prev, ...newProfiles]);
    }
    return newSpeakerVoices;
  };

  const cancelProcessing = () => {
    cancelRef.current = true;
    addLog('Cancellation requested...', 'warning');
    setStatus('Cancelling...');
  };

  const handleExtractLink = async (customUrl?: string | any) => {
    // If called directly from an event (like onClick), customUrl will be an Event object.
    // We only want to use it if it's explicitly a string.
    const urlToProcess = (typeof customUrl === 'string') ? customUrl : videoUrlInput;
    if (!urlToProcess || typeof urlToProcess !== 'string') return;

    const trimmedInput = urlToProcess.trim();
    if (!trimmedInput.startsWith('http')) {
      setError("Please enter a valid URL starting with http:// or https://");
      addLog("Invalid URL entered", "error");
      return;
    }

    setIsExtracting(true);
    setError(null);
    addLog(`Extracting video from link: ${trimmedInput}`, 'info');
    
    const extractWithRetry = async (retries = 2): Promise<any> => {
      try {
        const res = await fetch('/api/extract', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ url: trimmedInput })
        });
        
        const contentType = res.headers.get("content-type");
        if (!contentType || !contentType.includes("application/json")) {
          const text = await res.text();
          if (retries > 0 && (res.status === 502 || res.status === 503 || res.status === 504 || text.includes("<!doctype html>"))) {
            addLog("Server busy or restarting, retrying in 3s...", "warning");
            await new Promise(r => setTimeout(r, 3000));
            return extractWithRetry(retries - 1);
          }
          throw new Error(`Server error: ${text.substring(0, 100)}...`);
        }

        return await res.json();
      } catch (err) {
        if (retries > 0) {
          addLog("Connection failed, retrying in 3s...", "warning");
          await new Promise(r => setTimeout(r, 3000));
          return extractWithRetry(retries - 1);
        }
        throw err;
      }
    };

    try {
      const data = await extractWithRetry();
      
      if (data.metadata) {
        setVideoMetadata(data.metadata);
        if (data.metadata.title) {
          addLog(`Video Title: ${data.metadata.title}`, 'info');
        }
      }
      
      if (data.error) {
        if (data.escalate) {
           addLog("Static extraction failed, escalating to browser-side sniffing...", "warning");
           setSibnetEscalationUrl(trimmedInput);
           setIsExtracting(false);
           return;
        }
        if (trimmedInput.includes('sibnet.ru')) {
          setErrorDetails({
            message: "Sibnet Extraction Failed",
            troubleshooting: [
              "The video might be private or restricted (403 Forbidden).",
              "AI Studio/Trae internal proxies might be blocked by Sibnet (400 Error).",
              "TRY THIS: Open video page in browser, click PLAY, then right-click player -> 'Save Video As'.",
              "OR: Copy the direct .mp4 URL from browser developer tools (F12 -> Network).",
              "NOTE: You MUST download manually and then select the file from your computer.",
              "Manual upload is 100% reliable - bypasses all server IP blocks."
            ]
          });
        }
        const fullError = data.details ? `${data.error} (${data.details})` : data.error;
        const suggestion = data.suggestion || "Try downloading the video and uploading it manually.";
        throw new Error(`${fullError}. \n\n💡 İpucu: ${suggestion}`);
      }
      
      // Use proxy to bypass CORS when fetching the actual video file
      const proxiedUrl = `/api/proxy?url=${encodeURIComponent(data.videoUrl)}&originalUrl=${encodeURIComponent(videoUrlInput)}`;
      
      // Fetch the video as a blob to create a File object
      // This ensures existing logic (extractAudioNative, etc.) works
      setStatus('Downloading video for processing...');
      setDownloadProgress(0);
      
      let videoRes;
      try {
        videoRes = await fetch(proxiedUrl);
        if (!videoRes.ok) {
          let errorInfo = videoRes.statusText || `Status ${videoRes.status}`;
          try {
            // Clone the response because we might need to read it as text if JSON fails
            const responseClone = videoRes.clone();
            const errorData = await responseClone.json();
            if (errorData.error) errorInfo = errorData.error;
            if (errorData.details) errorInfo += ` (${errorData.details})`;
          } catch (e) {
            // If not JSON, try text
            try {
              const text = await videoRes.text();
              if (text && text.length < 500) errorInfo = text;
              else if (text) errorInfo = text.substring(0, 500) + "...";
            } catch (e2) {}
          }
          throw new Error(`Proxy error: ${errorInfo}`);
        }
      } catch (proxyErr: any) {
        console.warn("Proxy download failed, trying direct fetch as last resort...", proxyErr);
        addLog(`Proxy download failed (${proxyErr.message}), trying direct fetch...`, "warning");
        try {
          // Try direct fetch as a last resort
          videoRes = await fetch(data.videoUrl);
          if (!videoRes.ok) throw new Error(`Direct fetch failed with ${videoRes.status}`);
        } catch (directErr) {
          const proxyMsg = proxyErr instanceof Error ? proxyErr.message : String(proxyErr);
          const directMsg = directErr instanceof Error ? directErr.message : String(directErr);
          
          let suggestion = "\n\n💡 İpucu: Bu platform (Sibnet/Sendvid/Facebook vb.) proxy sunucumuzu engelliyor olabilir. En kesin çözüm: Videoyu tarayıcınızda açıp sağ tıklayıp 'Farklı Kaydet' diyerek bilgisayarınıza indirmek ve ardından bu sayfaya 'VİDEO YÜKLE' kısmından manuel olarak yüklemektir.";
          
          if (proxyMsg.includes("500")) {
             suggestion = "\n\n💡 İpucu: Sunucu hatası (500) alındı. Bu durum genellikle videonun silinmiş olduğunu veya erişilemez olduğunu gösterir. Linki tarayıcınızda açıp kontrol edin.";
          }

          throw new Error(`Video indirilemedi.${suggestion}\n\nDetaylar:\nProxy: ${proxyMsg}\nDirect: ${directMsg}`);
        }
      }
      
      const contentType = videoRes.headers.get('content-type');
      if (contentType && contentType.includes('text/html')) {
        const finalUrl = videoRes.url || data.videoUrl;
        addLog(`Received HTML instead of video from ${finalUrl.substring(0, 50)}...`, "warning");
        
        if (data.videoUrl.includes('drive.google.com')) {
          throw new Error("Google Drive is asking for manual download confirmation. \n\n💡 İpucu: Lütfen Drive dosyasının 'Herkesle Paylaşıldığından' (Public) emin olun. Eğer dosya çok büyükse, lütfen önce bilgisayarınıza indirip sonra buraya yükleyin.");
        }
        
        if (data.videoUrl.includes('sibnet.ru')) {
          const details: GeminiErrorDetails = {
            message: "Sibnet Video Download Error",
            troubleshooting: [
              "Try refreshing the page and extracting again.",
              "Open the video in your browser, click the PLAY button once to 'unlock' it, then right-click and 'Save Video As' to download manually.",
              "If you can play the video in your browser, right-click the player and select 'Open video in new tab', then copy that URL and paste it here.",
              "Sibnet links often expire quickly or require a 'play' action to unlock. Manual upload is the most reliable fallback."
            ]
          };
          setErrorDetails(details);
          throw new Error("Sibnet link returned an error page.");
        }
        
        throw new Error(`The link returned a web page instead of a video file. (Content-Type: ${contentType})\n\nURL: ${finalUrl}`);
      }

      const contentLength = videoRes.headers.get('content-length');
      const total = contentLength ? parseInt(contentLength, 10) : 0;
      let loaded = 0;
      
      if (total > 300 * 1024 * 1024) {
        addLog(`Warning: Large video detected (${(total / (1024 * 1024)).toFixed(1)} MB). This might require significant RAM. If the browser crashes, try downloading the video and uploading it manually.`, 'warning');
      }

      const reader = videoRes.body?.getReader();
      if (!reader) throw new Error("Could not start download stream");
      
      const chunks: Uint8Array[] = [];
      while(true) {
        const { done, value } = await reader.read();
        if (done) break;
        
        chunks.push(value);
        loaded += value.length;
        
        if (total > 0) {
          const percent = Math.round((loaded / total) * 100);
          setDownloadProgress(percent);
          setStatus(`Downloading video: ${percent}% (${(loaded / 1024 / 1024).toFixed(1)} MB)`);
        } else {
          setStatus(`Downloading video: ${(loaded / 1024 / 1024).toFixed(1)} MB`);
        }
      }
      
      const blob = new Blob(chunks, { type: videoRes.headers.get('content-type') || 'video/mp4' });
      addLog(`Downloaded video blob: ${blob.type}, size: ${(blob.size / 1024 / 1024).toFixed(2)} MB`, 'info');
      const file = new File([blob], "social_video.mp4", { type: blob.type || 'video/mp4' });
      
      setVideoFile(file);
      setVideoUrl(URL.createObjectURL(file));
      addLog('Video extracted and ready for dubbing!', 'success');
    } catch (err: any) {
      console.error("Extraction failed:", err);
      const errorMsg = err.message || "Failed to extract video from link";
      setError(errorMsg);
      addLog(`Extraction failed: ${errorMsg}`, 'error');
    } finally {
      setIsExtracting(false);
      setDownloadProgress(0);
    }
  };

  const handleSearchYouTube = async (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    if (!youtubeSearchQuery.trim()) return;

    setIsSearching(true);
    try {
      addLog(`Searching YouTube for: ${youtubeSearchQuery}`, 'info');
      const response = await fetch(`/api/youtube/search?q=${encodeURIComponent(youtubeSearchQuery)}`);
      if (!response.ok) throw new Error("Search failed");
      const data = await response.json();
      setYoutubeSearchResults(data.videos || []);
      addLog(`Found ${data.videos?.length || 0} YouTube videos.`, 'success');
    } catch (err: any) {
      addLog(`YouTube search failed: ${err.message}`, 'error');
    } finally {
      setIsSearching(false);
    }
  };

  const processVideo = async () => {
    if (!videoFile) return;
    
    setIsProcessing(true);
    setProcessingStep('analyzing');
    setStatus('Extracting audio for analysis...');
    addLog('Starting AI analysis...', 'info');

    try {
      const fullAudioBuffer = await getAudioBuffer(videoFile);
      const totalDuration = fullAudioBuffer.duration;

      let segments: TranscriptSegment[] = [];

      if (transcript.length > 0) {
        addLog('Existing transcript found. Skipping analysis and regenerating audio...', 'info');
        segments = transcript;
      } else {
        // Safe chunk sizes to stay within 20MB request limit (Base64 adds 33% overhead)
        // 16kHz Mono = 32KB/sec. 300s = 9.6MB (Raw) -> ~12.8MB (Base64) - Safe under 20MB
        let chunkSize = 60; 
        if (totalDuration > 300) chunkSize = 120;  
        if (totalDuration > 600) chunkSize = 180;  
        if (totalDuration > 900) chunkSize = 240;  
        if (totalDuration > 1200) chunkSize = 300; // Cap at 5 minutes for 20+ min videos

        const overlap = 5; 
        const numChunks = Math.ceil(totalDuration / chunkSize);
        
        addLog(`Optimization: Video split into ${numChunks} small batches (${(chunkSize/60).toFixed(1)}m each) to prevent token exhaustion.`, 'info');
        
        let allSegments: TranscriptSegment[] = [];
        let prevContext = ""; // Simulated context caching
        const targetHz = 16000;

        for (let i = 0; i < numChunks; i++) {
          if (cancelRef.current) throw new Error("Cancelled");
          
          const startOffset = Math.max(0, i * chunkSize - (i > 0 ? overlap : 0));
          const endOffset = Math.min((i + 1) * chunkSize, totalDuration);
          const actualOverlap = i > 0 ? (i * chunkSize - startOffset) : 0;
          
          setStatus(`Analyzing segment ${i + 1}/${numChunks} (${startOffset.toFixed(0)}s - ${endOffset.toFixed(0)}s)...`);
          setProgress(10 + (i / numChunks) * 40);
          
          const base64Audio = await sliceAudioBuffer(fullAudioBuffer, startOffset, endOffset, targetHz);
          if (!base64Audio) continue;

          const analysisModel = "gemini-3.1-flash-lite-preview";
          
          if (i > 0) {
            // More aggressive cooldown between chunks
            const chunkDelay = totalDuration > 600 ? 12000 : 6000; 
            await new Promise(resolve => setTimeout(resolve, chunkDelay));
          }

          let promptText = `Translate the audio to ${targetLang}. 
                Identify all speakers and precise timing. 
                CRITICAL: This is chunk ${i+1} of ${numChunks}. 
                ${prevContext ? `PREVIOUS CONTEXT (last few words): "${prevContext}"` : ""}
                Provide timing relative to the START OF THIS AUDIO CLIP (0.0s to ${(endOffset - startOffset).toFixed(1)}s).
                Ensure EVERY word is transcribed and translated. Do not summarize.`;

          if (videoMetadata) {
            const context = `VIDEO CONTEXT:\nTitle: ${videoMetadata.title || 'Unknown'}\nDescription: ${videoMetadata.description || 'No description'}\n` +
                            `Use this context to ensure technical terms and names are translated accurately for the ${targetLang} audience.`;
            promptText = `${context}\n\n${promptText}`;
          }

          const response = await callGeminiWithRetry(() => ai.models.generateContent({
            model: analysisModel,
            contents: [
              {
                inlineData: {
                  data: base64Audio,
                  mimeType: "audio/wav"
                }
              },
              { text: promptText }
            ],
            config: {
              systemInstruction: "You are a professional video dubbing assistant. Your task is to transcribe and translate audio files completely and accurately. \n\n" +
                               "SPEAKER IDENTIFICATION GUIDELINES:\n" +
                               "1. Identify unique speakers consistently (SPEAKER_01, SPEAKER_02, etc.).\n" +
                               "2. For each speaker, determine if they are 'Male', 'Female', or 'Unknown' based on voice characteristics. This is CRITICAL for assigning the correct output voice.\n" +
                               "3. Ensure every word is transcribed and translated. Do not summarize. Maintain high fidelity to the original speech.",
              maxOutputTokens: 25000,
              responseMimeType: "application/json",
              responseSchema: {
                type: Type.ARRAY,
                items: {
                  type: Type.OBJECT,
                  properties: {
                    startTime: { type: Type.NUMBER },
                    endTime: { type: Type.NUMBER },
                    translatedText: { type: Type.STRING },
                    speaker: { type: Type.STRING },
                    speakerGender: { type: Type.STRING, description: "Gender of the speaker: 'Male', 'Female', or 'Unknown'" }
                  },
                  required: ["startTime", "endTime", "translatedText", "speaker", "speakerGender"]
                }
              }
            }
          }), 5, 5000, (m) => addLog(m, 'warning'));

          let responseText = response.text || '[]';
          
          // Basic JSON repair
          if (responseText.trim().endsWith('}') && !responseText.trim().endsWith(']')) {
            responseText += ']';
          } else if (!responseText.trim().endsWith(']') && !responseText.trim().endsWith('}')) {
            const lastIndex = responseText.lastIndexOf('}');
            if (lastIndex !== -1) {
              responseText = responseText.substring(0, lastIndex + 1) + ']';
            }
          }

          try {
            const chunkSegments: TranscriptSegment[] = JSON.parse(responseText);
            
            // Capture last few words for context caching simulation
            if (chunkSegments.length > 0) {
              const lastSeg = chunkSegments[chunkSegments.length - 1];
              const words = (lastSeg.translatedText || lastSeg.text).split(' ');
              prevContext = words.slice(-15).join(' ');
            }

            // Filter and adjust segments
            const adjustedSegments = chunkSegments
              .map(seg => ({
                ...seg,
                startTime: seg.startTime + startOffset,
                endTime: seg.endTime + startOffset
              }))
              .filter(seg => {
                // If not the first chunk, only keep segments that START after the previous chunk's logical end
                if (i === 0) return true;
                const logicalPreviousEnd = i * chunkSize;
                return seg.startTime >= logicalPreviousEnd;
              });

            allSegments = [...allSegments, ...adjustedSegments];
          } catch (e) {
            addLog(`Warning: Failed to parse chunk ${i + 1}. Skipping.`, 'warning');
          }
        }

        segments = allSegments;
        if (segments.length === 0) throw new Error("No speech found in any chunk");
        
        addLog(`AI found ${segments.length} speech segments in total.`, 'success');

        // Sort segments by startTime to ensure chronological order
        segments.sort((a, b) => a.startTime - b.startTime);

        // Merge adjacent segments of the same speaker to reduce API calls
        const mergedSegments: TranscriptSegment[] = [];
        // Use "Super-Aggressive" merging for long videos to survive free tier limits
        // For 15+ min videos, we merge everything under 12s gap to create paragraphs
        let mergeThreshold = 1.5;
        let maxBatchWords = 80;
        if (totalDuration > 300) { mergeThreshold = 4.0; maxBatchWords = 100; }
        if (totalDuration > 900) { mergeThreshold = 12.0; maxBatchWords = 150; } 
        
        if (segments.length > 0) {
          let current = { ...segments[0] };
          for (let i = 1; i < segments.length; i++) {
            const next = segments[i];
            // Merge if same speaker and gap is less than threshold
            const currentWordCount = (current.text || "").split(/\s+/).length;
            if (next.speaker === current.speaker && (next.startTime - current.endTime) < mergeThreshold && currentWordCount < maxBatchWords) {
              current.endTime = next.endTime;
              current.text = (current.text || "").trim() + ". " + (next.text || "").trim();
              current.translatedText = (current.translatedText || "").trim() + ". " + (next.translatedText || "").trim();
            } else {
              mergedSegments.push(current);
              current = { ...next };
            }
          }
          mergedSegments.push(current);
        }
        segments = mergedSegments;
        setTranscript(segments);
        
        // PERSISTENCE: Save progress so user can resume if quota fails during dubbing
        if (videoFile) {
          const sessionKey = `sonitranslate_session_${videoFile.name}_${videoFile.size}`;
          localStorage.setItem(sessionKey, JSON.stringify({
            transcript: segments,
            speakerVoices,
            targetLang,
            timestamp: Date.now()
          }));
          addLog('İşlem ilerlemesi yerel hafızaya kaydedildi. Kota hatası alırsanız kaldığınız yerden devam edebilirsiniz.', 'info');
        }
        
        addLog(`Kotayı korumak için ${segments.length} adet akıllı paragraf konuşması oluşturuldu.`, 'success');
    }

      // Initialize speaker voices if not set
      const uniqueSpeakers = Array.from(new Set(segments.map(s => s.speaker)));
      const updatedSpeakerVoices = { ...speakerVoices };
      let changed = false;
      
      uniqueSpeakers.forEach((speaker) => {
        if (!updatedSpeakerVoices[speaker]) {
          // Find gender for this speaker
          const speakerSegments = segments.filter(s => s.speaker === speaker);
          const genderCounts = speakerSegments.reduce((acc: any, s) => {
            if (s.speakerGender && s.speakerGender !== 'Unknown') {
              acc[s.speakerGender] = (acc[s.speakerGender] || 0) + 1;
            }
            return acc;
          }, {});
          
          const detectedGender = genderCounts.Male > (genderCounts.Female || 0) ? 'Male' : 
                               (genderCounts.Female > (genderCounts.Male || 0) ? 'Female' : 'Unknown');
          
          // Filter suitable voices
          const maleVoices = voices.filter(v => v.gender === 'Male').map(v => v.id);
          const femaleVoices = voices.filter(v => v.gender === 'Female').map(v => v.id);
          
          if (detectedGender === 'Male') {
            updatedSpeakerVoices[speaker] = maleVoices[Math.floor(Math.random() * maleVoices.length)];
          } else if (detectedGender === 'Female') {
            updatedSpeakerVoices[speaker] = femaleVoices[Math.floor(Math.random() * femaleVoices.length)];
          } else {
            const allPrebuilt = voices.filter(v => v.gender !== 'Custom').map(v => v.id);
            updatedSpeakerVoices[speaker] = allPrebuilt[Math.floor(Math.random() * allPrebuilt.length)];
          }
          changed = true;
        }
      });
      
      if (changed) {
        setSpeakerVoices(updatedSpeakerVoices);
      }

      setProcessingStep('optimizing');
      setProgress(60);

      // Voice Cloning (Optional)
      if (autoCloneVoices) {
        setStatus('Cloning voices from original video...');
        const clonedVoices = await cloneVoicesFromVideo(videoFile, segments);
        setSpeakerVoices(prev => ({ ...prev, ...clonedVoices }));
        // Update local copy for immediate use in dubbing
        Object.assign(updatedSpeakerVoices, clonedVoices);
      }

      setProgress(70);

      // 3. Dubbing (TTS)
      setProcessingStep('dubbing');
      setStatus('Generating AI voices...');
      addLog('Translation complete. Generating dubbed audio...', 'success');

      const fullDubbedAudio = await generateFullDubbedAudio(segments, updatedSpeakerVoices);
      setDubbedAudioUrl(fullDubbedAudio);
      
      setStatus('Dubbing complete!');
      addLog('Dubbing process finished successfully!', 'success');
      setProgress(100);
    } catch (err: any) {
      console.error("Processing failed:", err);
      const details = parseGeminiError(err);
      setError(details.message);
      setErrorDetails(details);
      addLog(`Error: ${details.message}`, 'error');
    } finally {
      setIsProcessing(false);
      setProcessingStep('idle');
    }
  };

  const generateFullDubbedAudio = async (segments: TranscriptSegment[], currentSpeakerVoices?: Record<string, string>) => {
    const audioContext = new (window.AudioContext || (window as any).webkitAudioContext)();
    const sampleRate = 24000;
    
    // Calculate total duration based on the last segment's end time OR the video duration
    const lastSegmentEnd = segments.length > 0 ? Math.max(...segments.map(s => s.endTime)) : 0;
    const finalDuration = Math.max(lastSegmentEnd, duration);
    
    if (finalDuration === 0) return null;

    const offlineCtx = new OfflineAudioContext(1, Math.ceil(finalDuration * sampleRate), sampleRate);

    const voicesToUse = currentSpeakerVoices || speakerVoices;

    let completedCount = 0;
    let lastCompletedCount = -1;
    let lastProgressTime = Date.now();

    for (const segment of segments) {
      if (cancelRef.current) break;
      
      // Watchdog: If no progress for 5 minutes, something is wrong
      if (completedCount === lastCompletedCount && (Date.now() - lastProgressTime > 300000)) {
        throw new Error("DUBBING_WATCHDOG: Process stalled. Please try again with a smaller batch.");
      }

      if (completedCount > lastCompletedCount) {
        lastCompletedCount = completedCount;
        lastProgressTime = Date.now();
      }
      
      // Dynamic delay logic to stay under 15 RPM (Free tier is strict)
      // Long videos require more caution with the daily quota
      const baseDelay = duration > 1200 ? 15000 : (duration > 900 ? 10000 : (duration > 600 ? 8000 : 5000)); 
      
      if (completedCount > 0) {
        setStatus(`Waiting for rate limit cooldown... (${completedCount}/${segments.length})`);
        await new Promise(resolve => setTimeout(resolve, baseDelay));
      }
      
      setStatus(`Generating voice for segment ${completedCount + 1}/${segments.length}...`);
      
      // CRITICAL: Ensure we use the selected voice from speakerVoices state
      const selectedVoiceId = voicesToUse[segment.speaker] || 'Kore';
      const customProfile = customVoiceProfiles.find(p => p.id === selectedVoiceId);
      
      let prompt = `Say cheerfully in ${targetLang}: ${segment.translatedText}`;
      if (customProfile) {
        prompt = `Using this voice profile: ${customProfile.description}. Say in ${targetLang}: ${segment.translatedText}`;
      }

      const response = await callGeminiWithRetry(() => ai.models.generateContent({
        model: "gemini-3.1-flash-tts-preview",
        contents: [{ parts: [{ text: prompt }] }],
        config: {
          responseModalities: [Modality.AUDIO],
          speechConfig: {
            voiceConfig: {
              prebuiltVoiceConfig: { 
                // Use the selected prebuilt voice ID, or 'Kore' as fallback for custom profiles
                voiceName: customProfile ? 'Kore' : selectedVoiceId as any 
              }
            }
          }
        }
      }), 5, 5000, (m) => addLog(m, 'warning'));

      const base64Audio = response.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data;

      if (base64Audio) {
        try {
          const binaryString = atob(base64Audio);
          const buffer = new ArrayBuffer(binaryString.length);
          const bytes = new Uint8Array(buffer);
          for (let i = 0; i < binaryString.length; i++) {
            bytes[i] = binaryString.charCodeAt(i);
          }
          
          let audioBuffer: AudioBuffer;
          
          // Check for WAV header (RIFF) - Gemini TTS usually returns raw PCM, 
          // but some models or future updates might return WAV.
          if (bytes.length > 4 && bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46) {
            try {
              audioBuffer = await offlineCtx.decodeAudioData(buffer);
            } catch (decodeErr) {
              console.warn("Failed to decode WAV from TTS, trying raw PCM fallback...", decodeErr);
              // Fallback to raw PCM if WAV decoding fails
              const numSamples = Math.floor(bytes.length / 2);
              const pcmData = new Int16Array(buffer, 0, numSamples);
              audioBuffer = offlineCtx.createBuffer(1, numSamples, 24000);
              const channelData = audioBuffer.getChannelData(0);
              for (let i = 0; i < numSamples; i++) {
                channelData[i] = pcmData[i] / 32768;
              }
            }
          } else {
            // Raw PCM 16-bit 24kHz mono (Standard for Gemini TTS)
            const numSamples = Math.floor(bytes.length / 2);
            const pcmData = new Int16Array(buffer, 0, numSamples);
            audioBuffer = offlineCtx.createBuffer(1, numSamples, 24000);
            const channelData = audioBuffer.getChannelData(0);
            for (let i = 0; i < numSamples; i++) {
              channelData[i] = pcmData[i] / 32768;
            }
          }
          
          const source = offlineCtx.createBufferSource();
          source.buffer = audioBuffer;
          
          // Handle speed adjustment if segment is too short
          const segmentDuration = segment.endTime - segment.startTime;
          const audioDuration = audioBuffer.duration;
          
          // If audio is longer than segment, we speed it up
          if (audioDuration > segmentDuration && avoidOverlap) {
            // Calculate required speed to fit
            const requiredRate = audioDuration / segmentDuration;
            // Cap it at maxAcceleration
            source.playbackRate.value = Math.min(requiredRate, maxAcceleration);
            
            if (requiredRate > 1.2) {
              addLog(`Note: Segment ${completedCount + 1} sped up by ${source.playbackRate.value.toFixed(2)}x to fit timing.`, 'info');
            }
          }
          
          source.connect(offlineCtx.destination);
          source.start(segment.startTime);
        } catch (decodeErr) {
          console.error("Failed to decode TTS audio:", decodeErr);
          addLog(`Warning: Failed to decode audio for segment ${completedCount + 1}. Error: ${decodeErr instanceof Error ? decodeErr.message : String(decodeErr)}`, 'warning');
        }
      }
      completedCount++;
      setStepProgress(Math.round((completedCount / segments.length) * 100));
    }

    const finalBuffer = await offlineCtx.startRendering();
    const pcmData = finalBuffer.getChannelData(0);
    
    // Faster conversion to Int16
    const int16Data = new Int16Array(pcmData.length);
    for (let i = 0; i < pcmData.length; i++) {
      const s = Math.max(-1, Math.min(1, pcmData[i]));
      int16Data[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
    }
    
    const wavBlob = createWavBlob(int16Data, sampleRate);
    return URL.createObjectURL(wavBlob);
  };

  const createWavBlob = (pcmData: Int16Array, sampleRate: number) => {
    const buffer = new ArrayBuffer(44 + pcmData.length * 2);
    const view = new DataView(buffer);
    const writeString = (offset: number, string: string) => {
      for (let i = 0; i < string.length; i++) view.setUint8(offset + i, string.charCodeAt(i));
    };
    writeString(0, 'RIFF');
    view.setUint32(4, 36 + pcmData.length * 2, true);
    writeString(8, 'WAVE');
    writeString(12, 'fmt ');
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, 1, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * 2, true);
    view.setUint16(32, 2, true);
    view.setUint16(34, 16, true);
    writeString(36, 'data');
    view.setUint32(40, pcmData.length * 2, true);
    let offset = 44;
    for (let i = 0; i < pcmData.length; i++, offset += 2) view.setInt16(offset, pcmData[i], true);
    return new Blob([buffer], { type: 'audio/wav' });
  };

  const togglePlay = () => {
    if (videoRef.current && videoUrl) {
      if (videoRef.current.paused) {
        videoRef.current.play().catch(e => {
          if (e.name !== 'AbortError' && e.name !== 'NotSupportedError') {
            console.error("Video play error:", e);
          }
        });
        if (audioRef.current && dubbedAudioUrl) {
          audioRef.current.play().catch(e => {
            if (e.name !== 'AbortError' && e.name !== 'NotSupportedError') {
              console.error("Audio play error:", e);
            }
          });
        }
        setIsPlaying(true);
      } else {
        videoRef.current.pause();
        if (audioRef.current) audioRef.current.pause();
        setIsPlaying(false);
      }
    }
  };

  const resetVideo = () => {
    setVideoFile(null);
    setVideoUrl(null);
    setDubbedAudioUrl(null);
    setIsPlaying(false);
    setCurrentTime(0);
    setTranscript([]);
    setProcessingStep('idle');
    setProgress(0);
    setStepProgress(0);
    if (cameraStream) {
      cameraStream.getTracks().forEach(track => track.stop());
      setCameraStream(null);
    }
  };

  const seekTo = (time: number) => {
    if (videoRef.current) {
      videoRef.current.currentTime = time;
      setCurrentTime(time);
    }
    if (audioRef.current) {
      audioRef.current.currentTime = time;
    }
  };

  const skipForward = () => {
    if (videoRef.current) {
      seekTo(Math.min(videoRef.current.currentTime + 10, duration));
    }
  };

  const skipBackward = () => {
    if (videoRef.current) {
      seekTo(Math.max(videoRef.current.currentTime - 10, 0));
    }
  };

  const saveProject = () => {
    const projectData = {
      version: '1.0',
      timestamp: new Date().toISOString(),
      settings: {
        sourceLang,
        targetLang,
        maxAcceleration,
        avoidOverlap,
        literalizeNumbers,
        outputFormat,
        outputCodec,
        speakerVoices
      },
      transcript,
      customVoiceProfiles,
      videoMetadata: videoFile ? {
        name: videoFile.name,
        type: videoFile.type,
        size: videoFile.size
      } : null
    };

    const blob = new Blob([JSON.stringify(projectData, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `soni_project_${new Date().getTime()}.soni`;
    link.click();
    URL.revokeObjectURL(url);
  };

  const handleLoadProject = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = (event) => {
      try {
        const projectData = JSON.parse(event.target?.result as string);
        
        // Restore settings
        if (projectData.settings) {
          const s = projectData.settings;
          if (s.sourceLang) setSourceLang(s.sourceLang);
          if (s.targetLang) setTargetLang(s.targetLang);
          if (s.maxAcceleration) setMaxAcceleration(s.maxAcceleration);
          if (s.avoidOverlap !== undefined) setAvoidOverlap(s.avoidOverlap);
          if (s.literalizeNumbers !== undefined) setLiteralizeNumbers(s.literalizeNumbers);
          if (s.outputFormat) setOutputFormat(s.outputFormat);
          if (s.outputCodec) setOutputCodec(s.outputCodec);
          if (s.speakerVoices) setSpeakerVoices(s.speakerVoices);
        }

        // Restore content
        if (projectData.transcript) setTranscript(projectData.transcript);
        if (projectData.customVoiceProfiles) setCustomVoiceProfiles(projectData.customVoiceProfiles);

        // Alert user about video file
        if (projectData.videoMetadata) {
          setError(`Project loaded. Please re-select the video file: ${projectData.videoMetadata.name}`);
        } else {
          setStatus('Project loaded successfully');
        }
      } catch (err) {
        console.error("Failed to load project file", err);
        setError("Invalid project file format");
      }
    };
    reader.readAsText(file);
    // Reset input
    e.target.value = '';
  };

  const formatTime = (time: number) => {
    const mins = Math.floor(time / 60);
    const secs = Math.floor(time % 60);
    return `${mins}:${secs.toString().padStart(2, '0')}`;
  };

  const downloadCombinedVideo = async () => {
    if (!videoRef.current || !audioRef.current || !videoUrl || !dubbedAudioUrl) return;
    
    // Check if we can use FFmpeg for fast muxing (better quality, much faster)
    try {
      addLog('Starting High-Quality Muxing...', 'info');
      await fastMuxDownload();
      return;
    } catch (err) {
      console.warn("Fast muxing failed, falling back to real-time recording:", err);
      addLog('HQ Muxing failed, using real-time fallback...', 'warning');
    }

    setIsRecording(true);
    const video = videoRef.current;
    const audio = audioRef.current;
    video.currentTime = 0;
    audio.currentTime = 0;
    const videoStream = (video as any).captureStream();
    const audioStream = (audio as any).captureStream ? (audio as any).captureStream() : (audio as any).mozCaptureStream ? (audio as any).mozCaptureStream() : null;
    
    // Create a new stream and add only the FIRST video track and FIRST audio track
    const combinedStream = new MediaStream();
    const vTracks = videoStream.getVideoTracks();
    if (vTracks.length > 0) combinedStream.addTrack(vTracks[0]);
    
    if (audioStream) {
      const aTracks = audioStream.getAudioTracks();
      if (aTracks.length > 0) combinedStream.addTrack(aTracks[0]);
    }
    
    const mimeType = `video/${outputFormat};codecs=${outputCodec},opus`;
    const fallbackMimeType = `video/${outputFormat}`;
    
    let finalMimeType = '';
    if (MediaRecorder.isTypeSupported(mimeType)) {
      finalMimeType = mimeType;
    } else if (MediaRecorder.isTypeSupported(fallbackMimeType)) {
      finalMimeType = fallbackMimeType;
    } else {
      // Last resort fallback
      const types = ['video/webm', 'video/mp4'];
      for (const t of types) {
        if (MediaRecorder.isTypeSupported(t)) {
          finalMimeType = t;
          break;
        }
      }
    }

    if (!finalMimeType) {
      setError('Your browser does not support video recording.');
      setIsRecording(false);
      return;
    }

    const recorder = new MediaRecorder(combinedStream, { mimeType: finalMimeType });
    const chunks: Blob[] = [];
    recorder.ondataavailable = (e) => chunks.push(e.data);
    recorder.onstop = () => {
      const blob = new Blob(chunks, { type: finalMimeType });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `sonitranslate_dubbed.${outputFormat}`;
      link.click();
      setIsRecording(false);
    };
    recorder.start();
    video.play().catch(e => {
      if (e.name !== 'AbortError' && e.name !== 'NotSupportedError') {
        console.error("Video play error during download:", e);
      }
    });
    audio.play().catch(e => {
      if (e.name !== 'AbortError' && e.name !== 'NotSupportedError') {
        console.error("Audio play error during download:", e);
      }
    });
    video.onended = () => {
      recorder.stop();
      video.onended = null;
    };
  };

  const fastMuxDownload = async () => {
    if (!videoFile || !dubbedAudioUrl) return;
    
    setIsMuxing(true);
    setIsProcessing(true);
    setProcessingStep('dubbing');
    setStatus('Preparing High-Speed Muxer...');
    
    // Ensure FFmpeg is loaded
    if (!ffmpegRef.current) {
      const ffmpeg = new FFmpeg();
      const baseURL = 'https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.12.6/dist/esm';
      await ffmpeg.load({
        coreURL: await toBlobURL(`${baseURL}/ffmpeg-core.js`, 'text/javascript'),
        wasmURL: await toBlobURL(`${baseURL}/ffmpeg-core.wasm`, 'application/wasm'),
      });
      ffmpegRef.current = ffmpeg;
    }
    const ffmpeg = ffmpegRef.current;
    
    ffmpeg.on('log', ({ message }) => {
      if (message.includes('frame=')) {
        const frameMatch = message.match(/frame=\s*(\d+)/);
        if (frameMatch) {
          setStatus(`Muxing: ${frameMatch[1]} frames processed...`);
        }
      }
    });

    ffmpeg.on('progress', ({ progress }) => {
      setProgress(Math.round(progress * 100));
    });
    
    try {
      await runFFmpeg(async () => {
        try {
          setStatus('Optimizing media data...');
          
          const [videoData, audioData] = await Promise.all([
            fetchFile(videoFile),
            fetchFile(dubbedAudioUrl)
          ]);
          
          const inputExt = videoFile.name.split('.').pop()?.toLowerCase() || 'mp4';
          const vIn = `v.${inputExt}`;
          const aIn = `a.webm`; // Common for dubbed audio blobs
          const outNamePrefix = `out_${Date.now()}`;
          const outName = `${outNamePrefix}.${outputFormat}`;
          const isMp4 = outputFormat === 'mp4';

          await safeDelete(ffmpeg, vIn);
          await safeDelete(ffmpeg, aIn);
          await safeDelete(ffmpeg, outName);
          
          await ffmpeg.writeFile(vIn, videoData);
          await ffmpeg.writeFile(aIn, audioData);

          setStatus('Muxing (Turbo Mode)...');
          
          // Construct ducking filter expression from transcript
          const limitedTranscript = transcript.slice(0, 150);
          const duckingExpr = limitedTranscript.length > 0
            ? limitedTranscript.map(s => `between(t,${s.startTime.toFixed(3)},${s.endTime.toFixed(3)})`).join('+')
            : '0';

          // Robust check for audio stream existence (by trying a probe mux)
          let hasAudio = false;
          try {
            const probeCmd = ['-i', vIn, '-map', '0:a:0', '-c', 'copy', '-f', 'null', '-'];
            const probeExit = await ffmpeg.exec(probeCmd);
            hasAudio = probeExit === 0;
            if (!hasAudio) console.log("Video appears to have no audio stream.");
          } catch (e) {
            console.warn("Audio probe failed.");
          }

          // Smart Mux Filter
          const audioFilter = hasAudio 
            ? `[0:a]volume=if(${duckingExpr},0.2,1)[ducked];[ducked][1:a]amix=inputs=2:duration=first:dropout_transition=0:normalize=0[aout]`
            : `[1:a]volume=1.0[aout]`;

          const canCopy = (isMp4 && ['mp4', 'mov', 'm4v'].includes(inputExt)) || 
                          (!isMp4 && ['webm', 'mkv'].includes(inputExt));
          
          const commonArgs = ['-shortest', '-preset', 'ultrafast', '-threads', '1', '-y'];
          
          let cmd = [
            '-i', vIn,
            '-i', aIn,
            '-filter_complex', audioFilter,
            '-map', '0:v:0',
            '-map', '[aout]',
            '-c:v', canCopy ? 'copy' : (isMp4 ? 'libx264' : 'libvpx-vp9'),
            '-c:a', isMp4 ? 'aac' : 'libopus',
            '-b:a', '128k',
            ...commonArgs,
            outName
          ];
          
          if (!canCopy) cmd.push('-crf', '28');
          if (isMp4) cmd.push('-movflags', '+faststart');
          
          console.log(`FFmpeg Command (Attempt 1): ffmpeg ${cmd.join(' ')}`);
          let exitCode = await ffmpeg.exec(cmd);
          
          // Attempt 2: Simplified Fallback (No filtering)
          if (exitCode !== 0) {
            console.warn("Attempt 1 failed, trying fallback 1 (no filter)...");
            const fallback1 = [
              '-i', vIn,
              '-i', aIn,
              '-map', '0:v:0',
              '-map', '1:a:0',
              '-c:v', canCopy ? 'copy' : (isMp4 ? 'libx264' : 'libvpx-vp9'),
              '-c:a', isMp4 ? 'aac' : 'libopus',
              ...commonArgs,
              outName
            ];
            exitCode = await ffmpeg.exec(fallback1);
          }

          // Attempt 3: Extreme Fallback (Re-encode everything strictly)
          if (exitCode !== 0) {
            console.warn("Attempt 2 failed, trying extreme fallback (transcoding strictly)...");
            const extremeCmd = [
              '-i', vIn,
              '-i', aIn,
              '-c:v', isMp4 ? 'libx264' : 'libvpx-vp9',
              '-c:a', isMp4 ? 'aac' : 'libopus',
              '-b:a', '96k',
              '-map', '0:v:0',
              '-map', '1:a:0',
              '-shortest',
              '-preset', 'ultrafast',
              '-threads', '1',
              '-y',
              outName
            ];
            exitCode = await ffmpeg.exec(extremeCmd);
          }

          if (exitCode !== 0) {
            throw new Error(`FFmpeg error ${exitCode}. Please try MP4 format.`);
          }

          setStatus('Finalizing...');
          const data = await ffmpeg.readFile(outName);
          const blob = new Blob([data], { type: isMp4 ? 'video/mp4' : 'video/webm' });
          const url = URL.createObjectURL(blob);
          
          const link = document.createElement('a');
          link.href = url;
          link.download = `dubbed_${videoFile.name.split('.')[0]}.${outputFormat}`;
          link.click();
        } finally {
          // Cleanup
          await safeDelete(ffmpeg, 'v');
          await safeDelete(ffmpeg, 'a');
          const outName = `out.${outputFormat}`;
          await safeDelete(ffmpeg, outName);
        }
      });
      
      setStatus('Success!');
      addLog('Video downloaded successfully', 'success');
    } catch (err: any) {
      console.error("FFmpeg Muxing Error:", err);
      const msg = err.message || String(err);
      addLog(`HQ Muxing failed: ${msg}. Attempting fallback...`, 'warning');
      throw err;
    } finally {
      setIsMuxing(false);
      setIsProcessing(false);
      setProcessingStep('idle');
    }
  };

  // Player state sync
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    const updateProgress = () => {
      setCurrentTime(video.currentTime);
      // Sync audio with video if they drift apart
      if (audioRef.current && !audioRef.current.paused && isPlaying) {
        const drift = Math.abs(video.currentTime - audioRef.current.currentTime);
        if (drift > 0.2) { // Allow 200ms drift before forcing sync
          audioRef.current.currentTime = video.currentTime;
        }
      }
    };
    const updateDuration = () => setDuration(video.duration);

    video.addEventListener('timeupdate', updateProgress);
    video.addEventListener('loadedmetadata', updateDuration);
    
    // Initial sync in case metadata is already loaded
    if (video.duration) setDuration(video.duration);

    return () => {
      video.removeEventListener('timeupdate', updateProgress);
      video.removeEventListener('loadedmetadata', updateDuration);
    };
  }, [videoUrl, videoRef.current]); // Added videoRef.current to dependencies

  // Transcript highlighting logic
  useEffect(() => {
    if (transcript.length > 0) {
      // Find the segment that contains the current time
      const index = transcript.findIndex(s => currentTime >= s.startTime && currentTime <= s.endTime);
      
      // If no exact match, find the closest previous segment
      if (index === -1) {
        let lastIndex = -1;
        for (let i = transcript.length - 1; i >= 0; i--) {
          if (currentTime >= transcript[i].startTime) {
            lastIndex = i;
            break;
          }
        }
        if (lastIndex !== -1 && lastIndex !== activeSegmentIndex) {
          setActiveSegmentIndex(lastIndex);
        }
      } else if (index !== activeSegmentIndex) {
        setActiveSegmentIndex(index);
      }
    } else {
      setActiveSegmentIndex(null);
    }
  }, [currentTime, transcript]);

  // Auto-scroll logic
  useEffect(() => {
    if (followVideo && activeSegmentIndex !== null && activeSegmentRef.current && transcriptContainerRef.current) {
      const container = transcriptContainerRef.current;
      const element = activeSegmentRef.current;
      
      const containerTop = container.scrollTop;
      const containerBottom = containerTop + container.clientHeight;
      const elementTop = element.offsetTop;
      const elementBottom = elementTop + element.offsetHeight;
      
      // Only scroll if not fully visible in the container (with a small 10px buffer)
      const isVisible = (
        elementTop >= containerTop - 10 &&
        elementBottom <= containerBottom + 10
      );
      
      if (!isVisible) {
        container.scrollTo({
          top: elementTop - (container.clientHeight / 2) + (element.offsetHeight / 2),
          behavior: 'smooth'
        });
      }
    }
  }, [activeSegmentIndex, followVideo]);

  const totalBatchProgress = progress;

  // Recovery logic
  const sessionKey = videoFile ? `sonitranslate_session_${videoFile.name}_${videoFile.size}` : null;
  const savedSessionStr = sessionKey ? localStorage.getItem(sessionKey) : null;
  let recoveredTranscript = null;
  
  if (savedSessionStr) {
    try {
      const parsed = JSON.parse(savedSessionStr);
      recoveredTranscript = parsed.transcript;
    } catch(e) {}
  }

  return (
    <div className="min-h-screen bg-[#0a0a0a] text-white font-sans selection:bg-orange-500/30">
      {sibnetEscalationUrl && (
        <SibnetExtractionHelper 
          videoUrl={sibnetEscalationUrl} 
          onExtracted={(url) => {
            setSibnetEscalationUrl(null);
            handleExtractLink(url);
          }} 
        />
      )}
      {/* Header */}
      <header className="border-b border-white/5 bg-black/50 backdrop-blur-xl sticky top-0 z-50">
        <div className="max-w-7xl mx-auto px-6 h-20 flex items-center justify-between">
          <div className="flex items-center gap-4">
            <div className="w-12 h-12 bg-orange-600 rounded-2xl flex items-center justify-center shadow-2xl shadow-orange-600/40">
              <Languages className="w-7 h-7 text-white" />
            </div>
            <div>
              <h1 className="text-2xl font-black tracking-tighter">
                SONI<span className="text-orange-500">TRANSLATE</span>
              </h1>
              <p className="text-[10px] font-bold text-white/40 uppercase tracking-[0.2em]">AI Video Dubbing Studio</p>
            </div>
          </div>
          
          <div className="flex items-center gap-3">
            <div className="hidden md:flex items-center gap-2 px-4 py-2 bg-orange-500/10 rounded-xl border border-orange-500/20 shadow-[0_0_15px_rgba(249,115,22,0.1)] hover:border-orange-500/40 transition-all">
              <span className="text-[10px] uppercase font-black text-orange-500/60">Target Language</span>
              <select 
                value={targetLang}
                onChange={(e) => setTargetLang(e.target.value)}
                className="bg-transparent text-sm font-black text-white focus:outline-none cursor-pointer"
              >
                {languages.map(l => <option key={l} value={l} className="bg-[#1a1a1a]">{l}</option>)}
              </select>
            </div>
            
            <button 
              onClick={() => setRightPanel(rightPanel === 'settings' ? 'transcript' : 'settings')}
              className={`p-3 rounded-xl border transition-all ${rightPanel === 'settings' ? 'bg-orange-600 border-orange-500 text-white' : 'bg-white/5 border-white/10 text-white/60 hover:text-white'}`}
            >
              <Settings2 className="w-5 h-5" />
            </button>
          </div>
        </div>
      </header>

      <main className="max-w-7xl mx-auto px-6 py-8">
        {/* Error Display */}
        <AnimatePresence>
          {(error || errorDetails) && (
            <motion.div 
              initial={{ opacity: 0, y: -20 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -20 }}
              className="mb-8 p-6 rounded-[2rem] bg-red-500/10 border border-red-500/20 backdrop-blur-xl"
            >
              <div className="flex items-start gap-4">
                <div className="p-3 rounded-2xl bg-red-500/20 text-red-500">
                  <AlertCircle className="w-6 h-6" />
                </div>
                <div className="flex-1">
                  <h3 className="text-lg font-black text-red-500 uppercase tracking-tighter">
                    {errorDetails?.message || error || 'An error occurred'}
                  </h3>
                  {errorDetails?.troubleshooting && (
                    <div className="mt-4 space-y-3">
                      <p className="text-[10px] font-black text-white/40 uppercase tracking-widest">Troubleshooting Steps:</p>
                      <ul className="grid grid-cols-1 md:grid-cols-2 gap-2">
                        {errorDetails.troubleshooting.map((step, i) => (
                          <li key={i} className="flex items-center gap-2 text-xs text-white/60 bg-white/5 p-2 rounded-xl border border-white/5">
                            <div className="w-1.5 h-1.5 rounded-full bg-red-500/40" />
                            {step}
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                </div>
                <button 
                  onClick={() => { setError(null); setErrorDetails(null); }}
                  className="p-2 hover:bg-white/5 rounded-xl transition-colors text-white/20 hover:text-white"
                >
                  <RotateCcw className="w-5 h-5" />
                </button>
              </div>
            </motion.div>
          )}
        </AnimatePresence>

        <div className="grid grid-cols-1 lg:grid-cols-12 gap-8">
          
          {/* Left Column: Player & Configuration */}
          <div className="lg:col-span-8 space-y-6">
            
            {/* Top Level Tabs */}
            <div className="flex items-center justify-between mb-2">
              <div className="flex bg-white/5 p-1 rounded-2xl border border-white/10">
                <button 
                  onClick={() => setActiveMainTab('process')}
                  className={`px-6 py-2.5 rounded-xl text-xs font-black uppercase tracking-widest transition-all ${activeMainTab === 'process' ? 'bg-orange-600 shadow-lg shadow-orange-600/20 text-white' : 'text-white/40 hover:text-white'}`}
                >
                  <div className="flex items-center gap-2">
                    <Sparkles className="w-4 h-4" />
                    SONI STUDIO
                  </div>
                </button>
                <button 
                  onClick={() => setActiveMainTab('explore')}
                  className={`px-6 py-2.5 rounded-xl text-xs font-black uppercase tracking-widest transition-all ${activeMainTab === 'explore' ? 'bg-red-600 shadow-lg shadow-red-600/20 text-white' : 'text-white/40 hover:text-white'}`}
                >
                  <div className="flex items-center gap-2">
                    <Search className="w-4 h-4" />
                    YOUTUBE EXPLORER
                  </div>
                </button>
              </div>
              
              <div className="flex items-center gap-4">
                 <div className="flex items-center gap-2 px-3 py-1 bg-white/5 rounded-full border border-white/5">
                   <div className="w-2 h-2 rounded-full bg-green-500 animate-pulse" />
                   <span className="text-[10px] font-black text-white/60 uppercase tracking-widest">System Online</span>
                 </div>
              </div>
            </div>

            {activeMainTab === 'process' ? (
              <>
            <div className="flex items-center gap-4 mb-2">
              <div className="flex bg-white/5 p-1 rounded-2xl border border-white/10">
                <button 
                  onClick={() => { setVideoSource('upload'); setVideoUrl(null); setVideoFile(null); setDubbedAudioUrl(null); setTranscript([]); }}
                  className={`px-4 py-2 rounded-xl text-[10px] font-black uppercase tracking-widest transition-all ${videoSource === 'upload' ? 'bg-orange-600 text-white' : 'text-white/40 hover:text-white'}`}
                >
                  <div className="flex items-center gap-2">
                    <Upload className="w-3 h-3" />
                    File Upload
                  </div>
                </button>
                <button 
                  onClick={() => { setVideoSource('camera'); setVideoUrl(null); setVideoFile(null); setDubbedAudioUrl(null); setTranscript([]); }}
                  className={`px-4 py-2 rounded-xl text-[10px] font-black uppercase tracking-widest transition-all ${videoSource === 'camera' ? 'bg-orange-600 text-white' : 'text-white/40 hover:text-white'}`}
                >
                  <div className="flex items-center gap-2">
                    <Camera className="w-3 h-3" />
                    Camera Input
                  </div>
                </button>
                <button 
                  onClick={() => { setVideoSource('link'); setVideoUrl(null); setVideoFile(null); setDubbedAudioUrl(null); setTranscript([]); }}
                  className={`px-4 py-2 rounded-xl text-[10px] font-black uppercase tracking-widest transition-all ${videoSource === 'link' ? 'bg-orange-600 text-white' : 'text-white/40 hover:text-white'}`}
                >
                  <div className="flex items-center gap-2">
                    <Search className="w-3 h-3" />
                    Social Link
                  </div>
                </button>
              </div>
            </div>

            {!videoUrl ? (
              videoSource === 'upload' ? (
                <div 
                  {...getRootProps()} 
                  className={`
                    aspect-video rounded-[2rem] border-4 border-dashed transition-all duration-500 flex flex-col items-center justify-center gap-8 cursor-pointer
                    ${isDragActive ? 'border-orange-500 bg-orange-500/5 scale-[0.98]' : 'border-white/5 hover:border-white/10 hover:bg-white/5'}
                  `}
                >
                  <input {...getInputProps()} />
                  <div className="w-24 h-24 rounded-full bg-white/5 flex items-center justify-center group-hover:scale-110 transition-transform">
                    <Upload className="w-10 h-10 text-white/20" />
                  </div>
                  <div className="text-center">
                    <p className="text-2xl font-bold text-white/80">Drop your video here</p>
                    <p className="text-sm text-white/30 mt-2 font-medium">MP4, WebM or MOV (Max 100MB)</p>
                  </div>
                </div>
              ) : videoSource === 'camera' ? (
                <div className="aspect-video rounded-[2rem] border-4 border-white/5 bg-black overflow-hidden relative flex flex-col items-center justify-center">
                  {cameraStream ? (
                    <>
                      <video 
                        ref={cameraPreviewRef}
                        autoPlay 
                        muted 
                        playsInline
                        className="w-full h-full object-cover"
                      />
                      <div className="absolute bottom-8 flex flex-col items-center gap-4">
                        <button 
                          onClick={isRecordingCamera ? stopRecordingCamera : startRecordingCamera}
                          className={`w-20 h-20 rounded-full border-4 flex items-center justify-center transition-all ${isRecordingCamera ? 'border-red-500 bg-red-500/20' : 'border-white bg-white/10 hover:bg-white/20'}`}
                        >
                          <div className={`transition-all ${isRecordingCamera ? 'w-8 h-8 rounded-sm bg-red-500' : 'w-12 h-12 rounded-full bg-red-500'}`} />
                        </button>
                        <p className="text-[10px] font-black uppercase tracking-[0.2em] text-white/60">
                          {isRecordingCamera ? 'Stop Recording' : 'Start Recording'}
                        </p>
                      </div>
                    </>
                  ) : (
                    <div className="flex flex-col items-center gap-4">
                      <Loader2 className="w-12 h-12 text-orange-500 animate-spin" />
                      <p className="text-xs font-bold text-white/40 uppercase tracking-widest">Initializing Camera...</p>
                    </div>
                  )}
                </div>
              ) : (
                <div className="aspect-video rounded-[2rem] border-4 border-white/5 bg-white/5 flex flex-col items-center justify-center p-12">
                  <div className="w-24 h-24 rounded-full bg-orange-500/10 flex items-center justify-center mb-8">
                    <Search className="w-10 h-10 text-orange-500" />
                  </div>
                  <div className="w-full max-w-md space-y-4">
                    <div className="text-center space-y-2">
                      <h3 className="text-xl font-bold">Paste Video Link</h3>
                      <p className="text-sm text-white/40">Facebook, Instagram, YouTube, Drive or Direct Video URL</p>
                    </div>
                    <div className="relative group">
                      <div className="absolute -inset-1 bg-gradient-to-r from-orange-600 to-orange-400 rounded-2xl blur opacity-20 group-focus-within:opacity-40 transition duration-1000 group-focus-within:duration-200"></div>
                      <input 
                        type="text"
                        value={videoUrlInput}
                        onChange={(e) => {
                          let val = e.target.value;
                          // Automatically extract URL if user pastes an iframe tag
                          const srcMatch = val.match(/src=["']([^"']+)["']/i);
                          if (srcMatch) {
                            val = srcMatch[1];
                            if (val.startsWith('//')) val = 'https:' + val;
                            addLog(`Extracted URL from iframe tag: ${val.substring(0, 30)}...`, 'info');
                          }
                          
                          setVideoUrlInput(val);
                          if (val.includes('sibnet.ru')) {
                            // Automatically offer sniffer if it's sibnet
                          } else {
                            setIsSnifferActive(false);
                            setSniffedUrl(null);
                          }
                        }}
                        placeholder="Paste link here (.mp4, .m3u8, social links)..."
                        className="relative w-full bg-black/40 border border-white/10 rounded-2xl px-6 py-5 text-sm focus:outline-none focus:ring-2 focus:ring-orange-500/50 focus:bg-black/60 transition-all placeholder:text-white/20 shadow-2xl"
                      />
                      <button 
                        onClick={() => handleExtractLink()}
                        disabled={isExtracting || !videoUrlInput}
                        className="absolute right-2.5 top-2.5 bottom-2.5 px-8 bg-orange-600 hover:bg-orange-500 disabled:opacity-50 disabled:cursor-not-allowed rounded-xl text-[10px] font-black uppercase tracking-widest transition-all flex items-center gap-2 shadow-lg active:scale-95"
                      >
                        {isExtracting ? (
                          <>
                            <Loader2 className="w-3 h-3 animate-spin" />
                            {downloadProgress > 0 ? `${downloadProgress}%` : 'Extracting...'}
                          </>
                        ) : (
                          <>
                            <Sparkles className="w-3 h-3" />
                            {sniffedUrl ? 'Use Capured' : 'Extract'}
                          </>
                        )}
                      </button>
                    </div>

                    {videoUrlInput.includes('sibnet.ru') && !sniffedUrl && (
                      <motion.div 
                        initial={{ opacity: 0, y: 10 }}
                        animate={{ opacity: 1, y: 0 }}
                        className="pt-2"
                      >
                        <button 
                          onClick={() => {
                            setIsSnifferActive(!isSnifferActive);
                            setSnifferStatus(isSnifferActive ? 'idle' : 'waiting');
                          }}
                          className={`
                            w-full px-4 py-3 rounded-2xl border transition-all flex items-center justify-between group
                            ${isSnifferActive 
                              ? 'bg-orange-500/10 border-orange-500/50 text-orange-500' 
                              : 'bg-white/5 border-white/10 text-white/40 hover:bg-white/10 hover:text-white/60'}
                          `}
                        >
                          <div className="flex items-center gap-3">
                            <div className={`p-2 rounded-lg ${isSnifferActive ? 'bg-orange-500 text-white animate-pulse' : 'bg-white/5'}`}>
                              <Video className="w-4 h-4" />
                            </div>
                            <div className="text-left">
                              <p className="text-[10px] font-black uppercase tracking-widest">Sibnet Player Sniffer</p>
                              <p className="text-[8px] font-medium opacity-60">Use embedded player to bypass 403 blocks</p>
                            </div>
                          </div>
                          <div className="flex items-center gap-2">
                             <span className="text-[9px] font-bold uppercase tracking-tighter italic">
                               {isSnifferActive ? 'RUNNING' : 'EXPERIMENTAL'}
                             </span>
                             <div className={`w-1.5 h-1.5 rounded-full ${isSnifferActive ? 'bg-orange-500 animate-ping' : 'bg-white/20'}`} />
                          </div>
                        </button>
                      </motion.div>
                    )}

                    {isSnifferActive && (
                      <motion.div 
                        initial={{ opacity: 0, scale: 0.95, y: 10 }}
                        animate={{ opacity: 1, scale: 1, y: 0 }}
                        className="mt-4 rounded-[2.5rem] border-2 border-orange-500/30 bg-black/80 overflow-hidden shadow-[0_30px_60px_rgba(0,0,0,0.6)] backdrop-blur-2xl ring-1 ring-white/10"
                      >
                        <div className="p-5 border-b border-white/10 bg-gradient-to-r from-white/5 to-transparent flex items-center justify-between">
                          <div className="flex items-center gap-3">
                            <div className="relative flex items-center justify-center">
                              <div className="absolute w-6 h-6 bg-orange-500/30 rounded-full blur-md animate-pulse" />
                              <Loader2 className="w-4 h-4 text-orange-500 animate-spin relative z-10" />
                            </div>
                            <div className="flex flex-col">
                              <span className="text-[11px] font-black uppercase tracking-[0.2em] text-white/90">
                                Secure Sniffer Active
                              </span>
                              <span className="text-[8px] font-bold text-white/30 uppercase tracking-widest">
                                Bypassing Sibnet 403 Protections
                              </span>
                            </div>
                          </div>
                          <button 
                            onClick={() => setIsSnifferActive(false)}
                            className="w-8 h-8 rounded-full bg-white/5 hover:bg-red-500/20 text-white/20 hover:text-red-500 transition-all flex items-center justify-center group"
                          >
                            <Trash2 className="w-3.5 h-3.5 group-hover:scale-110 transition-transform" />
                          </button>
                        </div>
                        <div className="aspect-video bg-black/40 flex items-center justify-center relative group p-2">
                          <div className="w-full h-full rounded-[1.5rem] overflow-hidden border border-white/10 shadow-inner relative">
                            <iframe 
                              key={videoUrlInput}
                              src={`/api/sibnet-sniff-iframe?url=${encodeURIComponent(videoUrlInput)}`}
                              className="w-full h-full"
                              allow="autoplay; fullscreen"
                            />
                            {/* Overlay to guide user */}
                            {!sniffedUrl && (
                              <div className="absolute top-4 right-4 animate-bounce">
                                <div className="bg-orange-600 text-white text-[9px] font-black px-3 py-1 rounded-full shadow-lg uppercase tracking-widest ring-2 ring-white/20">
                                  Click Play Below ↓
                                </div>
                              </div>
                            )}
                          </div>
                        </div>
                        <div className="p-5 bg-gradient-to-b from-transparent to-orange-500/5 text-center">
                          <div className="flex items-center justify-center gap-3 text-white/40 mb-1">
                            <Info className="w-3 h-3 text-orange-500" />
                            <p className="text-[10px] font-medium leading-relaxed italic">
                              Click the <b>Play button</b> inside the player above.
                            </p>
                          </div>
                          <p className="text-[9px] font-bold text-white/20 uppercase tracking-[0.2em]">
                            Waiting for browser-level handshake...
                          </p>
                        </div>
                      </motion.div>
                    )}

                    {sniffedUrl && (
                      <motion.div 
                        initial={{ opacity: 0, scale: 0.95 }}
                        animate={{ opacity: 1, scale: 1 }}
                        className="mt-4 p-4 rounded-3xl bg-green-500/10 border border-green-500/30 flex items-center justify-between shadow-lg"
                      >
                        <div className="flex items-center gap-3">
                          <div className="w-10 h-10 rounded-full bg-green-500/20 flex items-center justify-center">
                            <CheckCircle2 className="w-5 h-5 text-green-500" />
                          </div>
                          <div>
                            <p className="text-[10px] font-black uppercase tracking-widest text-green-500">Video Link Captured!</p>
                            <p className="text-[9px] font-mono text-white/40 max-w-[200px] truncate">{sniffedUrl}</p>
                          </div>
                        </div>
                        <button 
                          onClick={() => setSniffedUrl(null)}
                          className="px-4 py-2 bg-green-500/20 hover:bg-green-500/30 text-green-500 rounded-xl text-[9px] font-black uppercase tracking-widest transition-all"
                        >
                          Clear
                        </button>
                      </motion.div>
                    )}

                    {isExtracting && downloadProgress > 0 && (
                      <div className="w-full space-y-2">
                        <div className="flex justify-between text-[10px] font-black uppercase tracking-widest text-white/40">
                          <span>Downloading Video</span>
                          <span>{downloadProgress}%</span>
                        </div>
                        <div className="h-1.5 w-full bg-white/5 rounded-full overflow-hidden">
                          <motion.div 
                            initial={{ width: 0 }}
                            animate={{ width: `${downloadProgress}%` }}
                            className="h-full bg-orange-500 shadow-[0_0_10px_rgba(249,115,22,0.5)]"
                          />
                        </div>
                      </div>
                    )}
                    <div className="flex items-center justify-center gap-4 pt-4">
                      <div className="flex items-center gap-2 text-[10px] font-bold text-white/20 uppercase tracking-widest">
                        <CheckCircle2 className="w-3 h-3" />
                        Facebook
                      </div>
                      <div className="w-1 h-1 bg-white/10 rounded-full" />
                      <div className="flex items-center gap-2 text-[10px] font-bold text-white/20 uppercase tracking-widest">
                        <CheckCircle2 className="w-3 h-3" />
                        Instagram
                      </div>
                      <div className="w-px h-3 bg-white/10" />
                      <div className="flex items-center gap-2 text-[10px] font-bold text-white/20 uppercase tracking-widest">
                        <CheckCircle2 className="w-3 h-3" />
                        YouTube
                      </div>
                      <div className="w-1 h-1 bg-white/10 rounded-full" />
                      <div className="flex items-center gap-2 text-[10px] font-bold text-white/20 uppercase tracking-widest">
                        <CheckCircle2 className="w-3 h-3" />
                        Drive
                      </div>
                      <div className="w-px h-3 bg-white/10" />
                      <div className="flex items-center gap-2 text-[10px] font-bold text-white/20 uppercase tracking-widest">
                        <CheckCircle2 className="w-3 h-3" />
                        Direct Link
                      </div>
                    </div>
                  </div>
                </div>
              )
            ) : (
              <div className="space-y-6">
                <VideoPreview 
                  videoUrl={videoUrl!}
                  dubbedAudioUrl={dubbedAudioUrl}
                  isPlaying={isPlaying}
                  currentTime={currentTime}
                  duration={duration}
                  volume={volume}
                  videoFileName={videoFile?.name}
                  onTogglePlay={togglePlay}
                  onSeek={seekTo}
                  onSkipForward={skipForward}
                  onSkipBackward={skipBackward}
                  onVolumeChange={(v) => {
                    setVolume(v);
                    if (videoRef.current) videoRef.current.volume = v;
                    if (audioRef.current) audioRef.current.volume = v;
                  }}
                  playbackRate={playbackRate}
                  onPlaybackRateChange={(rate) => {
                    setPlaybackRate(rate);
                    if (videoRef.current) videoRef.current.playbackRate = rate;
                    if (audioRef.current) audioRef.current.playbackRate = rate;
                  }}
                  onReset={resetVideo}
                  videoRef={videoRef}
                  audioRef={audioRef}
                  showSubtitles={showSubtitles}
                  onToggleSubtitles={() => setShowSubtitles(!showSubtitles)}
                  subtitleSettings={{
                    font: subtitleFont,
                    size: subtitleSize,
                    color: subtitleColor,
                    bgColor: hexToRgba(subtitleBgColor, subtitleBgOpacity)
                  }}
                  currentTranscript={transcript.find(s => currentTime >= s.startTime && currentTime <= s.endTime)}
                />

                {/* Processing Controls */}
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <div className="p-6 rounded-3xl bg-white/5 border border-white/10">
                    <div className="flex items-center gap-3 mb-4">
                      <Users className="w-5 h-5 text-orange-500" />
                      <h3 className="font-bold text-sm uppercase tracking-widest">Konuşmacı Sesleri</h3>
                    </div>
                    <div className="mb-4">
                      <p className="text-[10px] text-white/40 leading-relaxed italic">
                        * Yapay zeka sesleri otomatik atar. Cinsiyet uyumsuzluğu varsa buradan değiştirebilirsiniz.
                      </p>
                    </div>
                    <div className="space-y-3 max-h-48 overflow-y-auto pr-2 custom-scrollbar">
                      {(transcript.length > 0 
                        ? Array.from(new Set(transcript.map(s => s.speaker))).sort()
                        : ['SPEAKER_01', 'SPEAKER_02', 'SPEAKER_03', 'SPEAKER_04']
                      ).map(spk => (
                        <div key={spk} className="flex items-center justify-between gap-4">
                          <div className="flex items-center gap-2">
                            <div className="w-6 h-6 rounded-lg bg-orange-500/20 flex items-center justify-center">
                              <User className="w-3 h-3 text-orange-500" />
                            </div>
                            <span className="text-[10px] font-black text-white/40 uppercase tracking-widest">{spk}</span>
                          </div>
                          <select 
                            value={speakerVoices[spk as string] || 'Kore'}
                            onChange={(e) => setSpeakerVoices(prev => ({...prev, [spk as string]: e.target.value}))}
                            className="flex-1 bg-white/5 border border-white/10 rounded-xl px-3 py-2 text-xs font-bold focus:outline-none focus:ring-1 focus:ring-orange-500 cursor-pointer hover:bg-white/10 transition-colors"
                          >
                            {voices.map(v => (
                              <option key={v.id} value={v.id} className="bg-[#1a1a1a]">
                                {v.name} ({v.gender})
                              </option>
                            ))}
                          </select>
                        </div>
                      ))}
                    </div>
                  </div>

                  <div className="flex flex-col gap-4">
                    {recoveredTranscript && !transcript.length && !isProcessing && (
                      <motion.div 
                        initial={{ opacity: 0, y: 10 }}
                        animate={{ opacity: 1, y: 0 }}
                        className="p-6 bg-green-500/10 border border-green-500/20 rounded-3xl flex items-center justify-between mb-2 shadow-xl"
                      >
                        <div className="flex items-center gap-4">
                          <div className="w-10 h-10 rounded-full bg-green-500/20 flex items-center justify-center">
                            <Save className="w-5 h-5 text-green-500" />
                          </div>
                          <div>
                            <h4 className="text-xs font-black text-green-500 uppercase tracking-widest">Kayıtlı Çeviri Bulundu</h4>
                            <p className="text-[10px] text-white/50 leading-relaxed max-w-sm">
                              Bu video için daha önce oluşturulan çeviri verileri (transcript) bulundu. 
                              Kotanızı harcamamak için mevcut veriyi kullanabilirsiniz.
                            </p>
                          </div>
                        </div>
                        <button 
                          onClick={() => {
                            setTranscript(recoveredTranscript);
                            addLog("Kayıtlı oturum başarıyla geri yüklendi.", "success");
                          }}
                          className="px-6 py-3 bg-green-600 hover:bg-green-500 text-white rounded-2xl text-[10px] font-black uppercase tracking-widest transition-all shadow-lg active:scale-95"
                        >
                          Geri Yükle
                        </button>
                      </motion.div>
                    )}

                    {!dubbedAudioUrl && !isProcessing && (
                      <button
                        onClick={processVideo}
                        className="flex-1 bg-orange-600 hover:bg-orange-500 text-white rounded-3xl font-black text-lg shadow-2xl shadow-orange-600/20 transition-all active:scale-[0.98] flex items-center justify-center gap-3"
                      >
                        <Languages className="w-6 h-6" />
                        {transcript.length > 0 ? 'DUBBING OLUŞTUR' : 'ANALİZ ET VE SESLENDİR'}
                      </button>
                    )}

                    {dubbedAudioUrl && !isProcessing && (
                      <button
                        onClick={processVideo}
                        className="flex-1 bg-white/10 hover:bg-white/20 text-white rounded-3xl font-black text-xs border border-white/10 transition-all active:scale-[0.98] flex items-center justify-center gap-3 py-4 text-white uppercase tracking-widest"
                      >
                        <RotateCcw className="w-4 h-4 text-orange-500" />
                        SESLERİ YENİDEN OLUŞTUR
                      </button>
                    )}

                    {isProcessing && (
                      <div className="flex-1 bg-white/5 border border-white/10 rounded-3xl p-8 flex flex-col gap-6">
                        {(() => {
                          if (duration > 900) {
                            return (
                              <motion.div 
                                initial={{ opacity: 0, height: 0 }}
                                animate={{ opacity: 1, height: 'auto' }}
                                className="p-4 bg-purple-500/10 border border-purple-500/20 rounded-2xl flex gap-3"
                              >
                                <Sparkles className="w-5 h-5 text-purple-400 shrink-0" />
                                <div className="space-y-1">
                                  <h4 className="text-[10px] font-black text-purple-400 uppercase tracking-widest">Ultra Quota Optimizer V2 Active</h4>
                                  <p className="text-[10px] text-white/60 leading-relaxed">
                                    15 dakikadan uzun bir video yüklendi. Sistem şu an <b>"Akıllı Paragraf Birleştirme"</b> ve 
                                    <b>"10 Dakikalık Blok Analizi"</b> modunda çalışıyor. İlerlemeler otomatik kaydedilir.
                                  </p>
                                </div>
                              </motion.div>
                            );
                          }
                          if (duration > 600) {
                            return (
                              <motion.div 
                                initial={{ opacity: 0, height: 0 }}
                                animate={{ opacity: 1, height: 'auto' }}
                                className="p-4 bg-orange-500/10 border border-orange-500/20 rounded-2xl flex gap-3"
                              >
                                <Info className="w-5 h-5 text-orange-500 shrink-0" />
                                <div className="space-y-1">
                                  <h4 className="text-[10px] font-black text-orange-500 uppercase tracking-widest">Long Video Context Aware</h4>
                                  <p className="text-[10px] text-white/60 leading-relaxed">
                                    Bu video 10 dakikadan uzun olduğu için sistem otomatik olarak <b>"Kota Koruma"</b> moduna geçti. 
                                    İstekler seyreltilerek ve akıllıca birleştirilerek işleniyor.
                                  </p>
                                </div>
                              </motion.div>
                            );
                          }
                          return null;
                        })()}
                        <div className="flex items-center justify-between">
                          <div className="flex items-center gap-3">
                            <Loader2 className="w-5 h-5 text-orange-500 animate-spin" />
                            <p className="text-xs font-black text-white/40 uppercase tracking-widest">
                              Processing Video
                            </p>
                          </div>
                          <div className="flex flex-col items-end">
                            <span className="text-xl font-black text-orange-500">{progress}%</span>
                            <span className="text-[8px] font-bold text-white/20 uppercase tracking-widest">
                              Overall Progress
                            </span>
                          </div>
                        </div>

                        <div className="space-y-6">
                          {/* Metrics Grid */}
                          <div className="grid grid-cols-4 gap-2">
                            <div className="bg-white/5 rounded-xl p-2 border border-white/10 flex flex-col items-center backdrop-blur-md">
                              <span className="text-[7px] font-black text-white/40 uppercase tracking-widest">Elapsed</span>
                              <span className="text-[10px] font-mono font-bold text-orange-500">{metrics.elapsedTime.toFixed(1)}s</span>
                            </div>
                            <div className="bg-white/5 rounded-xl p-2 border border-white/10 flex flex-col items-center backdrop-blur-md">
                              <span className="text-[7px] font-black text-white/40 uppercase tracking-widest">API Calls</span>
                              <span className="text-[10px] font-mono font-bold text-blue-400">{metrics.apiCalls}</span>
                            </div>
                            <div className="bg-white/5 rounded-xl p-2 border border-white/10 flex flex-col items-center backdrop-blur-md">
                              <span className="text-[7px] font-black text-white/40 uppercase tracking-widest">Data</span>
                              <span className="text-[10px] font-mono font-bold text-purple-400">{(metrics.bytesProcessed / (1024 * 1024)).toFixed(1)}MB</span>
                            </div>
                            <div className="bg-white/5 rounded-xl p-2 border border-white/10 flex flex-col items-center backdrop-blur-md">
                              <span className="text-[7px] font-black text-white/40 uppercase tracking-widest">Speed</span>
                              <span className="text-[10px] font-mono font-bold text-green-400">
                                {metrics.elapsedTime > 0 ? (progress / metrics.elapsedTime).toFixed(2) : '0.00'}%/s
                              </span>
                            </div>
                          </div>

                          {/* Overall Progress Bar */}
                          <div className="h-2 bg-white/5 rounded-full overflow-hidden">
                            <motion.div 
                              className="h-full bg-orange-600 shadow-[0_0_20px_rgba(234,88,12,0.5)]"
                              initial={{ width: 0 }}
                              animate={{ width: `${progress}%` }}
                              transition={{ duration: 0.5 }}
                            />
                          </div>

                          {/* Step Indicators */}
                          <div className="grid grid-cols-3 gap-4">
                            {[
                              { id: 'analyzing', label: 'AI Analysis', est: '20-30s', icon: <Search className="w-3 h-3" /> },
                              { id: 'optimizing', label: 'Timing Sync', est: '5-10s', icon: <Clock className="w-3 h-3" /> },
                              { id: 'dubbing', label: 'Voice Dubbing', est: '10-20s', icon: <Mic2 className="w-3 h-3" /> }
                            ].map((step, idx) => {
                              const steps = ['analyzing', 'optimizing', 'dubbing'];
                              const currentIdx = steps.indexOf(processingStep);
                              const isCompleted = currentIdx > idx;
                              const isActive = processingStep === step.id;

                              return (
                                <div key={step.id} className={`space-y-3 p-3 rounded-2xl transition-all duration-500 ${isActive ? 'bg-white/5 border border-white/10' : 'bg-transparent border border-transparent'}`}>
                                  <div className="flex items-center justify-between">
                                    <div className="flex items-center gap-2">
                                      <div className={`p-1 rounded-md ${isActive ? 'bg-orange-500 text-white' : isCompleted ? 'bg-green-500/20 text-green-500' : 'bg-white/5 text-white/20'}`}>
                                        {step.icon}
                                      </div>
                                      <p className={`text-[8px] font-black uppercase tracking-tighter ${isActive ? 'text-orange-500' : isCompleted ? 'text-green-500' : 'text-white/20'}`}>
                                        {step.label}
                                      </p>
                                    </div>
                                    {isActive && <span className="text-[8px] font-mono text-orange-500 font-black">{stepProgress}%</span>}
                                  </div>
                                  <div className="h-1.5 bg-white/5 rounded-full overflow-hidden relative">
                                    <motion.div 
                                      className={`h-full transition-all duration-500 ${isCompleted ? 'bg-green-500' : isActive ? 'bg-orange-500 shadow-[0_0_10px_rgba(234,88,12,0.5)]' : 'bg-white/10'}`}
                                      initial={{ width: 0 }}
                                      animate={{ width: isCompleted ? '100%' : isActive ? `${stepProgress}%` : '0%' }}
                                    />
                                    {isActive && (
                                      <motion.div 
                                        className="absolute inset-0 bg-white/20"
                                        animate={{ x: ['-100%', '100%'] }}
                                        transition={{ repeat: Infinity, duration: 1.5, ease: "linear" }}
                                      />
                                    )}
                                  </div>
                                </div>
                              );
                            })}
                          </div>
                        </div>

                        {/* Detailed Logs */}
                        <div className="flex-1 bg-black/40 rounded-2xl border border-white/5 overflow-hidden flex flex-col">
                          <div className="px-3 py-2 border-b border-white/5 bg-white/5 flex items-center justify-between">
                            <span className="text-[8px] font-black text-white/40 uppercase tracking-widest">Live Processing Logs</span>
                            <span className="text-[8px] font-mono text-white/20">{processingLogs.length} events</span>
                          </div>
                          <div className="flex-1 overflow-y-auto p-3 space-y-2 font-mono text-[9px] scrollbar-hide max-h-[150px]">
                            {processingLogs.length === 0 && (
                              <div className="h-full flex items-center justify-center text-white/10 italic">
                                Awaiting events...
                              </div>
                            )}
                            {processingLogs.map((log, i) => (
                              <motion.div 
                                key={i}
                                initial={{ opacity: 0, x: -10 }}
                                animate={{ opacity: 1, x: 0 }}
                                className="flex gap-2"
                              >
                                <span className={
                                  log.type === 'success' ? 'text-green-400' :
                                  log.type === 'error' ? 'text-red-400' :
                                  log.type === 'warning' ? 'text-yellow-400' :
                                  'text-white/60'
                                }>
                                  {log.message}
                                </span>
                              </motion.div>
                            ))}
                          </div>
                        </div>

                        <div className="flex flex-col items-center gap-2 pt-4 border-t border-white/5">
                          <div className="flex items-center gap-2">
                            <div className="w-1.5 h-1.5 rounded-full bg-orange-500 animate-ping" />
                            <p className="text-[10px] font-bold text-white/80 uppercase tracking-widest text-center">{status}</p>
                          </div>
                        </div>
                        <button
                          onClick={cancelProcessing}
                          className="mt-2 w-full bg-red-500/10 hover:bg-red-500/20 text-red-500 border border-red-500/20 rounded-2xl py-3 text-xs font-black uppercase tracking-widest transition-all flex items-center justify-center gap-2 group"
                        >
                          <RotateCcw className="w-4 h-4 group-hover:rotate-180 transition-transform duration-500" />
                          Cancel Processing
                        </button>
                      </div>
                    )}
                    {dubbedAudioUrl && (
                      <div className="flex flex-col gap-4">
                        <div className="p-4 bg-white/5 border border-white/10 rounded-2xl space-y-3">
                          <div className="flex items-center justify-between">
                            <p className="text-[10px] font-black text-white/40 uppercase tracking-widest">Download Options</p>
                            <div className="flex items-center gap-2">
                              <div className="w-1.5 h-1.5 rounded-full bg-green-500" />
                              <span className="text-[8px] font-bold text-green-500 uppercase">Ready</span>
                            </div>
                          </div>
                          <div className="grid grid-cols-2 gap-3">
                            <div className="space-y-1">
                              <label className="text-[8px] font-bold text-white/20 uppercase tracking-tighter">Format</label>
                              <select 
                                value={outputFormat}
                                onChange={(e) => setOutputFormat(e.target.value)}
                                className="w-full bg-black/40 border border-white/10 rounded-lg px-2 py-1.5 text-[10px] font-bold focus:outline-none focus:ring-1 focus:ring-orange-500 cursor-pointer"
                              >
                                <option value="webm" className="bg-[#1a1a1a]">WebM</option>
                                <option value="mp4" className="bg-[#1a1a1a]">MP4</option>
                              </select>
                            </div>
                            <div className="space-y-1">
                              <label className="text-[8px] font-bold text-white/20 uppercase tracking-tighter">Codec</label>
                              <select 
                                value={outputCodec}
                                onChange={(e) => setOutputCodec(e.target.value)}
                                className="w-full bg-black/40 border border-white/10 rounded-lg px-2 py-1.5 text-[10px] font-bold focus:outline-none focus:ring-1 focus:ring-orange-500 cursor-pointer"
                              >
                                <option value="vp9" className="bg-[#1a1a1a]">VP9</option>
                                <option value="vp8" className="bg-[#1a1a1a]">VP8</option>
                                <option value="h264" className="bg-[#1a1a1a]">H.264</option>
                                <option value="avc1" className="bg-[#1a1a1a]">AVC1</option>
                              </select>
                            </div>
                          </div>
                        </div>
                        <button
                          onClick={downloadCombinedVideo}
                          disabled={isRecording || isMuxing}
                          className="flex-1 bg-orange-500 text-white hover:bg-orange-600 rounded-3xl font-black text-lg transition-all active:scale-[0.98] flex items-center justify-center gap-3 py-4 shadow-lg shadow-orange-500/20"
                        >
                          {(isRecording || isMuxing) ? <Loader2 className="w-6 h-6 animate-spin" /> : <Download className="w-6 h-6" />}
                          {isMuxing ? 'FAST MUXING...' : isRecording ? 'RECORDING...' : 'DOWNLOAD VIDEO'}
                        </button>
                        <p className="text-[8px] font-medium text-white/20 text-center uppercase tracking-widest">
                          Turbo Mux Technology (Lossless Video Copy)
                        </p>
                      </div>
                    )}
                  </div>
                </div>
              </div>
            )}
          </>
        ) : (
              <motion.div 
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                className="space-y-6"
              >
                <div className="p-8 rounded-[2.5rem] bg-stone-900/40 border border-white/5 backdrop-blur-2xl">
                  <h2 className="text-3xl font-black text-white uppercase tracking-tighter mb-4">
                    YouTube Explorer
                  </h2>
                  <p className="text-sm text-white/60 mb-8 max-w-xl">
                    Discover and import content directly from YouTube. Our extraction system runs transparently in your browser session.
                  </p>
                  
                  <form onSubmit={handleSearchYouTube} className="relative group">
                    <input 
                      type="text"
                      value={youtubeSearchQuery}
                      onChange={(e) => setYoutubeSearchQuery(e.target.value)}
                      placeholder="Search for videos, music, or news..."
                      className="w-full bg-white/5 border border-white/10 rounded-2xl py-5 pl-14 pr-32 text-white placeholder:text-white/20 focus:outline-none focus:border-red-500/50 focus:bg-white/10 transition-all font-medium"
                    />
                    <div className="absolute left-5 top-1/2 -translate-y-1/2 text-white/30 group-focus-within:text-red-500 transition-colors">
                      <Search className="w-5 h-5" />
                    </div>
                    <button 
                      type="submit"
                      disabled={isSearching}
                      className="absolute right-3 top-1/2 -translate-y-1/2 px-6 py-2.5 bg-red-600 text-white rounded-xl text-xs font-black uppercase tracking-widest hover:bg-red-500 transition-all disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                      {isSearching ? <Loader2 className="w-4 h-4 animate-spin" /> : 'Search'}
                    </button>
                  </form>
                </div>

                <div className="p-6 rounded-3xl bg-blue-500/5 border border-blue-500/10 flex items-center justify-between gap-6">
                  <div className="flex items-start gap-4">
                    <div className="p-3 rounded-2xl bg-blue-500/20 text-blue-400">
                      <Sparkles className="w-6 h-6" />
                    </div>
                    <div>
                      <h4 className="text-sm font-black text-white uppercase tracking-tight">Direct Browser Integration</h4>
                      <p className="text-[10px] text-white/40 mt-1 leading-relaxed">
                        YouTube üzerindeyken tek tıkla buraya video göndermek ister misin? Aşağıdaki kodu tarayıcı yer işaretlerine ekle:
                      </p>
                      <code className="block mt-2 p-2 bg-black/40 rounded-lg text-[8px] text-blue-400/80 font-mono break-all opacity-60 hover:opacity-100 transition-opacity cursor-pointer px-3" onClick={() => {
                        const code = `javascript:(function(){window.location.href='${window.location.origin}/?url='+encodeURIComponent(window.location.href);})();`;
                        navigator.clipboard.writeText(code);
                        addLog('Bookmarklet code copied to clipboard!', 'success');
                      }}>
                        javascript:(function(){`window.location.href='${window.location.origin}/?url='+encodeURIComponent(window.location.href);`})();
                      </code>
                    </div>
                  </div>
                </div>

                {youtubeSearchResults.length > 0 && (
                  <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-6">
                    {youtubeSearchResults.map((video) => (
                      <motion.div 
                        key={video.id}
                        initial={{ opacity: 0, scale: 0.9 }}
                        animate={{ opacity: 1, scale: 1 }}
                        className="group relative bg-white/5 rounded-3xl border border-white/5 overflow-hidden hover:border-red-500/30 transition-all"
                      >
                        <div className="aspect-video relative overflow-hidden">
                          <img 
                            src={`/api/proxy/image?url=${encodeURIComponent(video.thumbnail)}`}
                            alt={video.title}
                            className="w-full h-full object-cover group-hover:scale-110 transition-transform duration-500"
                          />
                          <div className="absolute bottom-3 right-3 px-2 py-1 bg-black/80 rounded-lg text-[10px] font-bold text-white">
                            {video.duration}
                          </div>
                        </div>
                        <div className="p-5 space-y-3">
                          <h3 className="font-bold text-sm text-white line-clamp-2 leading-tight group-hover:text-red-400 transition-colors">
                            {video.title}
                          </h3>
                          <div className="flex items-center justify-between text-[10px] font-black text-white/40 uppercase tracking-widest">
                            <span className="flex items-center gap-1">
                              <User className="w-3 h-3" />
                              {video.author}
                            </span>
                            <span>{video.views.toLocaleString()} views</span>
                          </div>
                          <button 
                            onClick={() => {
                              setVideoUrlInput(video.url);
                              setVideoSource('link');
                              setActiveMainTab('process');
                              handleExtractLink(video.url);
                            }}
                            className="w-full py-3 bg-white/5 hover:bg-red-600 text-white rounded-xl text-[10px] font-black uppercase tracking-widest transition-all border border-white/5 hover:border-red-500"
                          >
                            Import to Studio
                          </button>
                        </div>
                      </motion.div>
                    ))}
                  </div>
                )}
              </motion.div>
            )}
          </div>

          {/* Right Column: Transcript & Settings */}
          <div className="lg:col-span-4 space-y-6">
            <div className="flex items-center gap-2 p-1 bg-white/5 rounded-2xl border border-white/10">
              <button 
                onClick={() => setRightPanel('transcript')}
                className={`flex-1 py-2 rounded-xl text-[10px] font-black uppercase tracking-widest transition-all ${rightPanel === 'transcript' ? 'bg-white text-black shadow-lg' : 'text-white/40 hover:text-white'}`}
              >
                Transcript
              </button>
              <button 
                onClick={() => setRightPanel('settings')}
                className={`flex-1 py-2 rounded-xl text-[10px] font-black uppercase tracking-widest transition-all ${rightPanel === 'settings' ? 'bg-white text-black shadow-lg' : 'text-white/40 hover:text-white'}`}
              >
                Settings
              </button>
            </div>

            <AnimatePresence mode="wait">
              {rightPanel === 'settings' ? (
                <motion.div 
                  key="settings"
                  initial={{ opacity: 0, x: 20 }}
                  animate={{ opacity: 1, x: 0 }}
                  exit={{ opacity: 0, x: 20 }}
                  className="bg-white/5 border border-white/10 rounded-[2rem] p-8 space-y-8"
                >
                  <div className="flex items-center justify-between">
                    <h2 className="text-xl font-black uppercase tracking-tighter">Advanced Settings</h2>
                    <button onClick={() => setRightPanel('transcript')} className="text-white/40 hover:text-white"><RotateCcw className="w-5 h-5" /></button>
                  </div>

                  <div className="space-y-6">
                    <div className="space-y-3">
                      <div className="flex items-center justify-between">
                        <label className="text-[10px] font-black text-white/40 uppercase tracking-widest">Max Acceleration</label>
                        <span className="text-xs font-bold text-orange-500">{maxAcceleration}x</span>
                      </div>
                      <input 
                        type="range" min="1" max="2.5" step="0.1" value={maxAcceleration}
                        onChange={(e) => setMaxAcceleration(parseFloat(e.target.value))}
                        className="w-full h-1.5 bg-white/10 rounded-full appearance-none cursor-pointer accent-orange-600"
                      />
                    </div>

                    <div className="grid grid-cols-2 gap-4">
                      <div className="space-y-2">
                        <label className="text-[10px] font-black text-white/40 uppercase tracking-widest">Format</label>
                        <select 
                          value={outputFormat}
                          onChange={(e) => setOutputFormat(e.target.value)}
                          className="w-full bg-white/5 border border-white/10 rounded-xl px-3 py-2 text-xs font-bold focus:outline-none focus:ring-1 focus:ring-orange-500 cursor-pointer"
                        >
                          <option value="webm" className="bg-[#1a1a1a]">WebM</option>
                          <option value="mp4" className="bg-[#1a1a1a]">MP4</option>
                        </select>
                      </div>
                      <div className="space-y-2">
                        <label className="text-[10px] font-black text-white/40 uppercase tracking-widest">Codec</label>
                        <select 
                          value={outputCodec}
                          onChange={(e) => setOutputCodec(e.target.value)}
                          className="w-full bg-white/5 border border-white/10 rounded-xl px-3 py-2 text-xs font-bold focus:outline-none focus:ring-1 focus:ring-orange-500 cursor-pointer"
                        >
                          <option value="vp9" className="bg-[#1a1a1a]">VP9</option>
                          <option value="vp8" className="bg-[#1a1a1a]">VP8</option>
                          <option value="h264" className="bg-[#1a1a1a]">H.264</option>
                          <option value="avc1" className="bg-[#1a1a1a]">AVC1</option>
                        </select>
                      </div>
                    </div>

                    <div className="pt-6 border-t border-white/5 space-y-4">
                      <div className="flex items-center justify-between mb-2">
                        <div className="flex items-center gap-2">
                          <Languages className="w-4 h-4 text-orange-500" />
                          <p className="text-xs font-bold uppercase tracking-widest">Subtitles</p>
                        </div>
                        <button 
                          onClick={() => setShowSubtitles(!showSubtitles)}
                          className={`px-3 py-1 rounded-full text-[8px] font-black uppercase tracking-widest transition-all border ${showSubtitles ? 'bg-orange-600/20 border-orange-500/50 text-orange-400' : 'bg-white/5 border-white/10 text-white/20 hover:text-white/40'}`}
                        >
                          {showSubtitles ? 'On' : 'Off'}
                        </button>
                      </div>
                    </div>
                  </div>
                </motion.div>
              ) : (
                <motion.div 
                  key="transcript"
                  initial={{ opacity: 0, x: -20 }}
                  animate={{ opacity: 1, x: 0 }}
                  exit={{ opacity: 0, x: -20 }}
                  className="bg-white/5 border border-white/10 rounded-[2rem] flex flex-col h-[calc(100vh-12rem)]"
                >
                  <div className="p-6 border-b border-white/5 flex items-center justify-between">
                    <div className="flex items-center gap-3">
                      <h2 className="font-black uppercase tracking-tighter">Transcript</h2>
                      <button 
                        onClick={() => setFollowVideo(!followVideo)}
                        className={`px-2 py-0.5 rounded-full text-[8px] font-black uppercase tracking-widest transition-all border ${followVideo ? 'bg-orange-600/20 border-orange-500/50 text-orange-400' : 'bg-white/5 border-white/10 text-white/20 hover:text-white/40'}`}
                      >
                        {followVideo ? 'Following' : 'Follow'}
                      </button>
                      {transcript.length > 0 && (
                        <div className="relative group/dl">
                          <button 
                            className="flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[8px] font-black uppercase tracking-widest transition-all border bg-green-600/10 border-green-500/30 text-green-400 hover:bg-green-600/20"
                          >
                            <Download className="w-2 h-2" />
                            Download
                          </button>
                          <div className="absolute right-0 top-full mt-2 w-32 bg-[#1a1a1a] border border-white/10 rounded-xl shadow-2xl opacity-0 invisible group-hover/dl:opacity-100 group-hover/dl:visible transition-all z-50 p-1">
                            <button 
                              onClick={() => downloadTranscript('txt')}
                              className="w-full text-[8px] font-black uppercase tracking-widest p-2 hover:bg-white/5 rounded-lg text-left transition-colors"
                            >
                              Text (.txt)
                            </button>
                            <button 
                              onClick={() => downloadTranscript('srt')}
                              className="w-full text-[8px] font-black uppercase tracking-widest p-2 hover:bg-white/5 rounded-lg text-left transition-colors"
                            >
                              Subtitles (.srt)
                            </button>
                            <button 
                              onClick={() => downloadTranscript('json')}
                              className="w-full text-[8px] font-black uppercase tracking-widest p-2 hover:bg-white/5 rounded-lg text-left transition-colors"
                            >
                              JSON (.json)
                            </button>
                          </div>
                        </div>
                      )}
                      {transcript.length > 0 && (
                        <button 
                          onClick={autoTranslateTranscript}
                          disabled={isTranslating}
                          className="flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[8px] font-black uppercase tracking-widest transition-all border bg-orange-600/10 border-orange-500/30 text-orange-400 hover:bg-orange-600/20 disabled:opacity-50"
                        >
                          {isTranslating ? <Loader2 className="w-2 h-2 animate-spin" /> : <Sparkles className="w-2 h-2" />}
                          Auto-Translate
                        </button>
                      )}
                    </div>
                    {dubbedAudioUrl && <CheckCircle2 className="w-5 h-5 text-green-500" />}
                  </div>

                  <div 
                    ref={transcriptContainerRef}
                    className="flex-1 overflow-y-auto p-6 space-y-6 custom-scrollbar scroll-smooth relative"
                  >
                    {transcript.length > 0 ? (
                      transcript.map((seg, i) => (
                        <div 
                          key={i}
                          ref={i === activeSegmentIndex ? activeSegmentRef : null}
                          className={`group p-4 rounded-2xl transition-all cursor-pointer border relative overflow-hidden ${i === activeSegmentIndex ? 'bg-orange-600/20 border-orange-500/50 scale-[1.02] shadow-[0_0_20px_rgba(234,88,12,0.1)]' : 'bg-white/5 border-transparent hover:border-white/10'}`}
                          onClick={() => seekTo(seg.startTime)}
                        >
                          {i === activeSegmentIndex && (
                            <div className="absolute left-0 top-0 bottom-0 w-1 bg-orange-500 animate-pulse" />
                          )}
                          <div className="flex items-center justify-between mb-3">
                            <div className="flex items-center gap-2">
                              <div className={`w-6 h-6 rounded-lg flex items-center justify-center ${i === activeSegmentIndex ? 'bg-orange-500/40' : 'bg-white/10'}`}>
                                <User className={`w-3 h-3 ${i === activeSegmentIndex ? 'text-white' : 'text-white/40'}`} />
                              </div>
                              <span className={`text-[9px] font-black uppercase tracking-widest ${i === activeSegmentIndex ? 'text-orange-400' : 'text-white/30'}`}>{seg.speaker}</span>
                            </div>
                            <span className={`text-[9px] font-mono ${i === activeSegmentIndex ? 'text-orange-400' : 'text-white/20'}`}>{formatTime(seg.startTime)}</span>
                          </div>
                          <p className={`text-[11px] italic mb-2 leading-relaxed transition-colors ${i === activeSegmentIndex ? 'text-white/60' : 'text-white/40'}`}>{seg.text}</p>
                          <p className={`text-sm font-bold leading-relaxed transition-colors ${i === activeSegmentIndex ? 'text-white' : 'text-white/90 group-hover:text-orange-400'}`}>
                            {seg.translatedText}
                          </p>
                        </div>
                      ))
                    ) : (
                      <div className="h-full flex flex-col items-center justify-center text-center opacity-10 py-20">
                        <Info className="w-16 h-16 mb-4" />
                        <p className="font-black uppercase tracking-widest">No Data Processed</p>
                      </div>
                    )}
                  </div>
                </motion.div>
              )}
            </AnimatePresence>
          </div>

        </div>
      </main>

      <style dangerouslySetInnerHTML={{ __html: `
        .custom-scrollbar::-webkit-scrollbar { width: 4px; }
        .custom-scrollbar::-webkit-scrollbar-track { background: transparent; }
        .custom-scrollbar::-webkit-scrollbar-thumb { background: rgba(255, 255, 255, 0.05); border-radius: 10px; }
        .custom-scrollbar::-webkit-scrollbar-thumb:hover { background: rgba(255, 255, 255, 0.1); }
        input[type=range]::-webkit-slider-thumb { -webkit-appearance: none; height: 16px; width: 16px; border-radius: 50%; background: #fff; cursor: pointer; border: 2px solid #ea580c; box-shadow: 0 0 10px rgba(0,0,0,0.5); }
      `}} />
    </div>
  );
}
