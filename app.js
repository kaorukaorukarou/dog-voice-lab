'use strict';
const $ = id => document.getElementById(id);
const MAX_RECORD_MS = 60000;
const MAX_IMPORT_BYTES = 40 * 1024 * 1024;
const CSV_FIELDS = ['id','date','dog','session','observer','context','vocal','confidence','notes','duration_s','sample_rate_hz','rms','peak','zero_crossing_rate','spectral_centroid_hz','spectral_flatness','f0_hz','f0_valid_frames','f0_total_frames','analyzed_spectral_frames','accepted_spectral_frames','ai_model','ai_label','ai_score','ai_dog_label','ai_dog_score','ai_window_start_s','audio_type'];
let db = null, activeCapture = null, currentBlob = null, currentFeatures = null, playerUrl = null, analysisWorker = null;
let nextRequestId = 1;
let currentAI = null;
let currentPCM = null;
window.CanineLab = {getLatestAudio:()=>currentBlob, getLatestPCM:()=>currentPCM, getLatestAI:()=>currentAI, setAIResult: value=>{currentAI=value;}};
function setStatus(message, type = '') { $('status').textContent = message; $('status').className = 'status ' + type; }
function setSaveStatus(message, type = '') { $('saveStatus').textContent = message; $('saveStatus').className = 'status ' + type; }
function errorText(error) {return error && error.message ? error.message : String(error);}
function releasePlayerUrl() {if (playerUrl) URL.revokeObjectURL(playerUrl); playerUrl = null;}
function assignAudio(blob) {releasePlayerUrl(); playerUrl = URL.createObjectURL(blob); $('player').src = playerUrl;}
function showGuide() {
  const isiPhone = /iPhone|iPod/i.test(navigator.userAgent);
  const secure = window.isSecureContext && location.protocol !== 'file:';
  if (isiPhone || !secure) $('iosGuide').hidden = false;
  if (!secure) {
    $('iosGuideText').textContent = '録音にはHTTPSのURLが必要です。このHTMLを「ファイル」から直接開く方法ではマイクが使えない場合があります。GitHub Pagesなどで公開し、Safariから開いてください。';
  } else if (isiPhone) {
    $('iosGuideText').textContent = 'HTTPS上で開いています。マイクの利用を許可し、録音中は画面を開いたままにしてください。「共有」→「ホーム画面に追加」でアプリ風に利用できます。';
  }
  if (!window.MediaRecorder || !navigator.mediaDevices?.getUserMedia) {
    $('start').disabled = true;
    setStatus('この環境ではマイク録音を利用できません。HTTPSでSafariから開くか、音声ファイルを読み込んでください。', 'error');
  }
}
function openDB() {
  return new Promise((resolve, reject) => {
    const r = indexedDB.open('canine-lab-v1', 1);
    r.onupgradeneeded = () => {if (!r.result.objectStoreNames.contains('observations')) r.result.createObjectStore('observations', {keyPath:'id'});};
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}
function requestDB(mode, cb) {
  if (!db) return Promise.reject(new Error('保存領域が利用できません'));
  return new Promise((resolve, reject) => {
    const tx = db.transaction('observations', mode);
    const req = cb(tx.objectStore('observations'));
    tx.oncomplete = () => resolve(req?.result);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error('保存が中断されました'));
  });
}
function getAll() {return requestDB('readonly', store => store.getAll());}
function csvQuote(value) {const text = String(value ?? ''); return /[",\r\n]/.test(text) ? '"' + text.replace(/"/g, '""') + '"' : text;}
function csvData(rows) {return '\uFEFF' + [CSV_FIELDS.join(','), ...rows.map(row => CSV_FIELDS.map(k => csvQuote(row[k])).join(','))].join('\r\n');}
function filenameFor(row) {
  const mime = row.audio_type || row.audio?.type || '';
  const ext = mime.includes('mp4') || mime.includes('aac') ? 'm4a' : mime.includes('wav') ? 'wav' : mime.includes('mpeg') ? 'mp3' : mime.includes('ogg') ? 'ogg' : 'webm';
  return `dog_${row.id}.${ext}`;
}
function downloadFile(blob, name) {
  const url = URL.createObjectURL(blob), anchor = document.createElement('a');
  anchor.href = url; anchor.download = name; document.body.appendChild(anchor); anchor.click(); anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 120000);
}
async function exportFile(blob, name) {
  // iOS's share sheet can save to Files. If that fails, use Safari's download manager.
  if (navigator.share && navigator.canShare && typeof File !== 'undefined') {
    const file = new File([blob], name, {type:blob.type || 'application/octet-stream'});
    try {
      if (navigator.canShare({files:[file]})) {
        await navigator.share({files:[file], title:name});
        return '共有メニューを開きました。「ファイルに保存」を選んでください。';
      }
    } catch (err) {
      if (err.name === 'AbortError') return '共有操作をキャンセルしました。';
      // NotAllowedError: user activation can expire during ZIP creation; use download fallback.
    }
  }
  downloadFile(blob, name);
  return 'ファイルのダウンロードを開始しました。iPhoneではSafariの「ダウンロード」を確認してください。';
}
function drawWave(samples) {
  const c = $('wave'), ctx = c.getContext('2d'), w = c.width, h = c.height;
  ctx.clearRect(0,0,w,h); ctx.strokeStyle = '#bfd5d9';ctx.lineWidth = 1;
  ctx.beginPath();ctx.moveTo(0,h/2);ctx.lineTo(w,h/2);ctx.stroke();
  if (!samples?.length) return;
  ctx.strokeStyle = '#118391';ctx.lineWidth = 1.6;ctx.beginPath();
  for (let x=0; x<w; x++) {
    const a = Math.floor(x*samples.length/w), b = Math.max(a+1, Math.floor((x+1)*samples.length/w));
    let low = 1, high = -1;
    // Maximum of 300 samples per pixel to avoid UI blocking on long recordings.
    const jump = Math.max(1, Math.ceil((b-a)/300));
    for (let j=a;j<b;j+=jump) {const v=samples[j];if(v<low)low=v;if(v>high)high=v;}
    ctx.moveTo(x, h/2 - low*h*.43);ctx.lineTo(x, h/2 - high*h*.43);
  }
  ctx.stroke();
}
function showFeatures(f) {
  const fields = [
    ['持続時間', `${f.duration_s} 秒`],['RMS',f.rms],['Peak',f.peak],['ZCR',f.zero_crossing_rate],
    ['Centroid',f.spectral_centroid_hz == null ? '算出不能' : f.spectral_centroid_hz + ' Hz'],
    ['F0（参考）',f.f0_hz == null ? '算出不能' : f.f0_hz + ' Hz'],
    ['Flatness',f.spectral_flatness ?? '算出不能'],['F0 有効フレーム',`${f.f0_valid_frames}/${f.f0_total_frames}`]
  ];
  $('stats').replaceChildren(...fields.map(([key,value]) => {
    const box=document.createElement('div'), strong=document.createElement('span'), name=document.createElement('span');
    box.className='stat';strong.className='value';strong.textContent=value;name.className='metric';name.textContent=key;box.append(strong,name);return box;
  }));
}
function concatPCM(parts) {
  const len = parts.reduce((n, a) => n + a.length,0), pcm = new Float32Array(len);
  let offset = 0;
  for (const p of parts) {pcm.set(p,offset);offset += p.length;}
  return pcm;
}
async function decodeAudio(blob) {
  const Ctx = window.AudioContext || window.webkitAudioContext;
  if (!Ctx) throw new Error('Web Audio API が利用できません');
  const ctx = new Ctx();
  try {
    const buffer = await blob.arrayBuffer();
    const decoded = await ctx.decodeAudioData(buffer);
    if (decoded.duration > 120) throw new Error('解析可能な音声は120秒までです');
    const samples = new Float32Array(decoded.length);
    for (let ch=0;ch<decoded.numberOfChannels;ch++) {
      const channel = decoded.getChannelData(ch);
      for (let i=0;i<channel.length;i++) samples[i] += channel[i]/decoded.numberOfChannels;
    }
    return {samples, sampleRate:decoded.sampleRate};
  } finally {await ctx.close().catch(() => {});}
}
function useAnalysisWorker(samples, sampleRate) {
  return new Promise((resolve,reject) => {
    if (!analysisWorker) analysisWorker = new Worker('./analysis-worker.js');
    const reqId = nextRequestId++;
    const onMessage = e => {
      if (e.data.requestId !== reqId) return;
      analysisWorker.removeEventListener('message',onMessage);
      analysisWorker.removeEventListener('error',onError);
      if (e.data.error) reject(new Error(e.data.error)); else resolve(e.data.features);
    };
    const onError = e => {analysisWorker.removeEventListener('message',onMessage);analysisWorker.removeEventListener('error',onError);reject(new Error('音声解析プログラムの読み込みに失敗しました'));};
    analysisWorker.addEventListener('message',onMessage);
    analysisWorker.addEventListener('error',onError);
    analysisWorker.postMessage({requestId:reqId, samples:samples.buffer, sampleRate},[samples.buffer]);
  });
}
async function processAudio(blob, fallbackPCM=null, fallbackSR=null) {
  currentBlob=null;currentFeatures=null;currentAI=null;currentPCM=null;$('save').disabled=true;setSaveStatus('');
  document.dispatchEvent(new CustomEvent('canine:audio-reset'));
  setStatus('音声を読み込み、解析しています…');
  try {
    let data;
    try {data=await decodeAudio(blob);} catch (decodingError) {
      if (!fallbackPCM?.length || !fallbackSR) throw decodingError;
      data={samples:fallbackPCM,sampleRate:fallbackSR};
    }
    drawWave(data.samples);
    currentPCM={pcm:data.samples.slice(),sampleRate:data.sampleRate};
    const features = await useAnalysisWorker(data.samples, data.sampleRate);
    currentBlob=blob;currentFeatures=features;assignAudio(blob);showFeatures(features);
    $('save').disabled=!db;
    document.dispatchEvent(new CustomEvent('canine:audio-ready', {detail:{blob}}));
    setStatus(`解析完了：${features.duration_s} 秒。発声時の状況を選択し、記録を保存してください。`, 'success');
  } catch (err) {
    drawWave(null);
    setStatus(`解析できません：${errorText(err)}。音声ファイルはM4A/WAVなどをお試しください。`, 'error');
  }
}
function fmtTime(ms) {const seconds=Math.max(0,Math.floor(ms/1000));return `${String(Math.floor(seconds/60)).padStart(2,'0')}:${String(seconds%60).padStart(2,'0')}`;}
function finishCaptureUI() {
  $('start').disabled=false;$('stop').disabled=true;$('file').disabled=false;
  $('recordingIndicator').hidden=true;$('level').style.width='0%';
}
function cleanupCapture(cap) {
  if (cap.timer) clearInterval(cap.timer);
  if (cap.monitorRAF) cancelAnimationFrame(cap.monitorRAF);
  if (cap.stream) cap.stream.getTracks().forEach(track => track.stop());
  try {cap.source?.disconnect();cap.script?.disconnect();cap.silent?.disconnect();cap.analyser?.disconnect();} catch(_){}
  if (cap.ctx) cap.ctx.close().catch(()=>{});
  activeCapture=null;finishCaptureUI();
}
function stopRecording() {
  if (!activeCapture) return;
  const cap=activeCapture;
  if (cap.recorder.state==='recording') {
    cap.recorder.stop();
    $('stop').disabled=true;
    setStatus('録音を終了しました。解析中…');
  }
}
$('start').addEventListener('click',async()=>{
  if (activeCapture) return;
  if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) {
    setStatus('マイク録音に対応していません。HTTPSのSafariで開いてください。','error');return;
  }
  let stream=null,ctx=null;
  $('start').disabled=true;setStatus('マイクに接続しています…');
  try {
    stream=await navigator.mediaDevices.getUserMedia({audio:{echoCancellation:false,noiseSuppression:false,autoGainControl:false},video:false});
    const preferred=['audio/mp4','audio/webm;codecs=opus','audio/webm','audio/ogg;codecs=opus'];
    const mime=preferred.find(t => typeof MediaRecorder.isTypeSupported==='function' && MediaRecorder.isTypeSupported(t));
    const recorder=new MediaRecorder(stream,mime?{mimeType:mime}:undefined);
    const cap={recorder,stream,chunks:[],pcm:[],ctx:null,source:null,analyser:null,script:null,silent:null,timer:null,monitorRAF:null,startTime:Date.now()};
    activeCapture=cap;
    recorder.ondataavailable=e=>{if(e.data.size)cap.chunks.push(e.data);};
    recorder.onerror=e=>{setStatus('録音中にエラーが発生しました：'+errorText(e.error||e),'error');};
    recorder.onstop=async()=>{
      cleanupCapture(cap);
      if (!cap.chunks.length) {setStatus('音声が記録されませんでした。再度録音してください。','error');return;}
      const blob=new Blob(cap.chunks,{type:recorder.mimeType||cap.chunks[0].type||'audio/mp4'});
      await processAudio(blob,concatPCM(cap.pcm),cap.ctx?.sampleRate);
    };
    // Secondary PCM capture enables acoustic analysis if Safari cannot decode its own MP4 recording.
    // Audio does NOT play through speakers (gain=0), preventing feedback.
    try {
      const Ctx=window.AudioContext||window.webkitAudioContext;
      ctx=new Ctx();cap.ctx=ctx;
      // Never await resume() here: on iOS its Promise can remain pending after the permission dialog.
      ctx.resume().catch(() => {});
      cap.source=ctx.createMediaStreamSource(stream);
      cap.analyser=ctx.createAnalyser();cap.analyser.fftSize=1024;
      cap.source.connect(cap.analyser);
      if (ctx.createScriptProcessor) {
        cap.script=ctx.createScriptProcessor(4096,1,1);cap.silent=ctx.createGain();cap.silent.gain.value=0;
        cap.source.connect(cap.script);cap.script.connect(cap.silent);cap.silent.connect(ctx.destination);
        cap.script.onaudioprocess=e=>{
          if (cap.recorder.state==='recording') cap.pcm.push(new Float32Array(e.inputBuffer.getChannelData(0)));
        };
      }
      const tmp=new Uint8Array(cap.analyser.fftSize);
      const meter=()=>{
        if (activeCapture!==cap) return;
        cap.analyser.getByteTimeDomainData(tmp);let power=0;
        for (const x of tmp) power += ((x-128)/128)**2;
        $('level').style.width=Math.min(100,Math.sqrt(power/tmp.length)*350)+'%';
        cap.monitorRAF=requestAnimationFrame(meter);
      };
      meter();
    } catch(e) {
      // MediaRecorder may still work even when Web Audio monitoring is unavailable.
      if (ctx) {ctx.close().catch(()=>{});cap.ctx=null;}
    }
    recorder.start(1000);
    cap.startTime=Date.now();
    $('stop').disabled=false;$('file').disabled=true;$('recordingIndicator').hidden=false;
    cap.timer=setInterval(()=>{
      const ms=Date.now()-cap.startTime;$('elapsed').textContent=fmtTime(ms);
      if (ms>=MAX_RECORD_MS) stopRecording();
    },200);
    $('elapsed').textContent='00:00';setStatus('録音中です。画面を閉じずに、終了時に「録音停止」を押してください。');
  } catch(err) {
    if (activeCapture) cleanupCapture(activeCapture);
    else {if(stream)stream.getTracks().forEach(t=>t.stop());if(ctx)ctx.close().catch(()=>{});$('start').disabled=false;}
    let reason=errorText(err);
    if (err.name==='NotAllowedError') reason='マイクが許可されていません。iPhoneのSafariでサイトのマイク設定を確認してください。';
    if (err.name==='NotFoundError') reason='利用できるマイクが見つかりません。';
    setStatus('録音できません：'+reason,'error');
  }
});
$('stop').addEventListener('click',stopRecording);
$('file').addEventListener('change', async e=>{
  const file=e.target.files?.[0];if(!file)return;
  e.target.value='';
  if (file.size>MAX_IMPORT_BYTES) {setStatus('読み込める音声ファイルは40MBまでです。','error');return;}
  await processAudio(file);
});
$('clear').addEventListener('click',()=>{
  $('session').value='';$('context').value='';$('vocal').value='不明';$('confidence').value='高';$('notes').value='';setSaveStatus('');
});
$('save').addEventListener('click', async()=>{
  if (!currentBlob || !currentFeatures)return;
  if (!$('context').value) {setSaveStatus('発声時の状況を選択してください。','error');$('context').focus();return;}
  const id=(crypto.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`);
  const row={id,date:new Date().toISOString(),dog:$('dog').value.trim()||'DOG-001',session:$('session').value.trim(),observer:$('observer').value.trim(),context:$('context').value,vocal:$('vocal').value,confidence:$('confidence').value,notes:$('notes').value.trim(),...currentFeatures,ai_model:currentAI?.model||'',ai_label:currentAI?.topLabel||'',ai_score:currentAI?.topScore??'',ai_dog_label:currentAI?.dogLabel||'',ai_dog_score:currentAI?.dogScore??'',ai_window_start_s:currentAI?.startS??'',audio_type:currentBlob.type,audio:currentBlob};
  try {
    $('save').disabled=true;
    await requestDB('readwrite',store=>store.put(row));
    setSaveStatus('保存しました。次の音声を録音してください。','success');await refreshRecords();
  } catch (e) {setSaveStatus('保存できません：'+errorText(e),'error');$('save').disabled=false;}
});
function addMiniButton(parent,label,kind,handler) {
  const btn=document.createElement('button');btn.type='button';btn.className='btn mini '+(kind||'');btn.textContent=label;btn.addEventListener('click',handler);parent.appendChild(btn);
}
async function refreshRecords() {
  if (!db)return;
  const rows=(await getAll()).sort((a,b)=>b.date.localeCompare(a.date));
  $('count').textContent=`${rows.length} 件`;
  const list=$('recordList');list.replaceChildren();
  if (!rows.length) {const p=document.createElement('p');p.className='empty';p.textContent='記録はまだありません。';list.append(p);return;}
  for (const row of rows) {
    const card=document.createElement('article'),heading=document.createElement('div'),date=document.createElement('strong'),vocal=document.createElement('span'),meta=document.createElement('p'),actions=document.createElement('div');
    card.className='record-card';heading.className='record-header';meta.className='record-meta';actions.className='record-actions';
    date.textContent=new Date(row.date).toLocaleString('ja-JP');vocal.textContent=row.vocal;vocal.className='count';
    heading.append(date,vocal);
    meta.textContent=`${row.context} ／ ${row.duration_s}秒 ／ RMS ${row.rms} ／ F0 ${row.f0_hz??'—'} Hz`+(row.ai_dog_label?' ／ AI: '+row.ai_dog_label:'');
    addMiniButton(actions,'再生','',()=>{$('player').pause();assignAudio(row.audio);$('player').play().catch(()=>{});$('player').scrollIntoView({behavior:'smooth',block:'center'});});
    addMiniButton(actions,'音声保存','',async()=>{$('exportStatus').textContent=await exportFile(row.audio,filenameFor(row));});
    addMiniButton(actions,'削除','danger',async()=>{
      if (!confirm('この音声と記録を削除します。よろしいですか？'))return;
      await requestDB('readwrite',store=>store.delete(row.id));await refreshRecords();
    });
    card.append(heading,meta,actions);list.append(card);
  }
}
$('csv').addEventListener('click',async()=>{
  try {
    const rows=await getAll();if(!rows.length){$('exportStatus').textContent='保存済みの記録がありません。';return;}
    $('exportStatus').textContent=await exportFile(new Blob([csvData(rows)],{type:'text/csv;charset=utf-8'}),'canine_observations.csv');
  } catch(e) {$('exportStatus').textContent='CSV出力に失敗しました：'+errorText(e);}
});
// ZIP archive in STORE mode, without third-party dependencies. Files include unchanged recorded audio.
const encoder=new TextEncoder();
const byte16=n=>[n&255,n>>>8&255];const byte32=n=>[n&255,n>>>8&255,n>>>16&255,n>>>24&255];
const crcTable=Array.from({length:256},(_,i)=>{let c=i;for(let j=0;j<8;j++)c=(c&1)?(0xedb88320^(c>>>1)):(c>>>1);return c>>>0;});
function crc32(data) {let c=0xffffffff;for (const b of data)c=crcTable[(c^b)&255]^(c>>>8);return (c^0xffffffff)>>>0;}
async function makeZip(files) {
  const local=[],central=[];let offset=0;
  for(const {name,blob} of files) {
    const content=new Uint8Array(await blob.arrayBuffer()),nameBytes=encoder.encode(name),size=content.length,crc=crc32(content);
    const flags=0x0800;
    const lh=new Uint8Array([80,75,3,4,...byte16(20),...byte16(flags),...byte16(0),...byte16(0),...byte16(0),...byte32(crc),...byte32(size),...byte32(size),...byte16(nameBytes.length),...byte16(0)]);
    local.push(lh,nameBytes,content);
    const ch=new Uint8Array([80,75,1,2,...byte16(20),...byte16(20),...byte16(flags),...byte16(0),...byte16(0),...byte16(0),...byte32(crc),...byte32(size),...byte32(size),...byte16(nameBytes.length),...byte16(0),...byte16(0),...byte16(0),...byte16(0),...byte32(0),...byte32(offset)]);
    central.push(ch,nameBytes);offset += lh.length+nameBytes.length+size;
  }
  const centralSize=central.reduce((sum,x)=>sum+x.length,0),count=files.length;
  const end=new Uint8Array([80,75,5,6,...byte16(0),...byte16(0),...byte16(count),...byte16(count),...byte32(centralSize),...byte32(offset),...byte16(0)]);
  return new Blob([...local,...central,end],{type:'application/zip'});
}
$('zip').addEventListener('click',async()=>{
  const btn=$('zip');btn.disabled=true;btn.textContent='ZIPを作成中…';
  try {
    const rows=await getAll();if(!rows.length){$('exportStatus').textContent='保存済みの記録がありません。';return;}
    const files=[{name:'observations.csv',blob:new Blob([csvData(rows)],{type:'text/csv;charset=utf-8'})},...rows.map(row=>({name:`audio/${filenameFor(row)}`,blob:row.audio}))];
    const zip=await makeZip(files);
    $('exportStatus').textContent=await exportFile(zip,'canine_dataset.zip');
  } catch(e) {$('exportStatus').textContent='ZIP出力に失敗しました：'+errorText(e);}
  finally{btn.disabled=false;btn.textContent='音声＋CSV（ZIP）';}
});
$('deleteAll').addEventListener('click',async()=>{
  if (!confirm('すべての録音と記録を削除します。バックアップ後に実行してください。続行しますか？'))return;
  try{await requestDB('readwrite',store=>store.clear());await refreshRecords();$('exportStatus').textContent='すべての記録を削除しました。';}
  catch(e){$('exportStatus').textContent='削除できません：'+errorText(e);}
});
(async()=>{
  showGuide();drawWave(null);
  try {db=await openDB();await refreshRecords();}
  catch(e){setStatus('ブラウザ内保存を利用できません：'+errorText(e),'error');$('save').disabled=true;}
  if ('serviceWorker' in navigator && location.protocol==='https:') navigator.serviceWorker.register('./sw.js').catch(()=>{});
})();
