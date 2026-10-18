/* Research use only: Google YAMNet, pretrained on AudioSet. No translation or emotion inference. */
const $ = id => document.getElementById(id);
const VERSION = '0.3';
const MODEL_NAME = 'Google YAMNet / AudioSet (521 categories)';
const MEDIA_LIB = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-audio@1.1.0/+esm';
const WASM_ROOT = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-audio@1.1.0/wasm';
const MODEL_URL = 'https://storage.googleapis.com/mediapipe-models/audio_classifier/yamnet/float32/1/yamnet.tflite';
const DOG_SOUND_NAMES = ['Bark','Yip','Howl','Bow-wow','Growling','Whimper (dog)'];
const DOG_CONTEXT_NAMES = ['Dog','Domestic animals, pets','Animal'];
const dogMap = new Map([
 ['Bark','吠え'],['Yip','甲高い短い吠え'],['Howl','遠吠え'],['Bow-wow','ワンワンという吠え'],
 ['Growling','唸り'],['Whimper (dog)','クンクン鳴き'],['Dog','犬の音'],
 ['Domestic animals, pets','ペットの音'],['Animal','動物の音'],['Speech','ヒトの発話'],
 ['Music','音楽'],['Silence','無音'],['Whimper','すすり泣き（一般）']
]);
let aiClassifier = null;
let loadingPromise = null;
let busy = false;
const showStatus=(s,type='')=>{const el=$('aiStatus');el.textContent=s;el.className='status '+type;};
function humanLabel(label){return dogMap.get(label)||label;}
function setReady(ready){$('classifyAI').disabled=!ready||busy;}
function resetAI(){
 window.CanineLab?.setAIResult(null);
 $('aiResults').hidden=true;
 $('aiHeadline').textContent='—';
 $('aiDescription').textContent='';
 $('aiDogScores').replaceChildren();
 $('aiTopScores').replaceChildren();
 setReady(false);showStatus('録音またはファイル読み込み後に、AI分類できます。');
}
document.addEventListener('canine:audio-reset',resetAI);
document.addEventListener('canine:audio-ready',()=>{
 setReady(true);showStatus('音声を読み込みました。「この音声をAI分類」を押してください。');
});
function dedupeCategories(result){
 const scoreByName=new Map();
 for(const frame of (result||[])){
   for(const head of (frame.classifications||[])){
     for(const obj of (head.categories||[])){
       const key=obj.categoryName||obj.displayName||`class-${obj.index}`;
       const score=Number(obj.score)||0;
       scoreByName.set(key, Math.max(score,scoreByName.get(key)||0));
     }
   }
 }
 return [...scoreByName.entries()].map(([label,score])=>({label,score})).sort((a,b)=>b.score-a.score);
}
async function loadModel(){
 if(aiClassifier)return aiClassifier;
 if(loadingPromise)return loadingPromise;
 loadingPromise=(async()=>{
   showStatus('公開済みAIモデルを読み込み中です（初回は通信が必要です）…');
   const {AudioClassifier,FilesetResolver}=await import(MEDIA_LIB);
   const fileset=await FilesetResolver.forAudioTasks(WASM_ROOT);
   // Model stays remote until loaded. Audio recordings are NOT uploaded to a server.
   aiClassifier=await AudioClassifier.createFromOptions(fileset,{
     baseOptions:{modelAssetPath:MODEL_URL,delegate:'CPU'},
     runningMode:'AUDIO_CLIPS',
     maxResults:-1,
     scoreThreshold:0
   });
   return aiClassifier;
 })();
 try{return await loadingPromise;}finally{loadingPromise=null;}
}
async function decodeToMono(blob){
 const AC=window.AudioContext||window.webkitAudioContext;
 if(!AC)throw new Error('このブラウザには音声解析APIがありません');
 const ctx=new AC();
 try{
   const arr=await blob.arrayBuffer();
   const decoded=await ctx.decodeAudioData(arr);
   if(decoded.duration>120)throw new Error('音声は120秒以内にしてください');
   const mono=new Float32Array(decoded.length);
   for(let c=0;c<decoded.numberOfChannels;c++){
     const samples=decoded.getChannelData(c);
     for(let i=0;i<samples.length;i++)mono[i]+=samples[i]/decoded.numberOfChannels;
   }
   return {pcm:mono,sampleRate:decoded.sampleRate};
 }finally{await ctx.close().catch(()=>{});}
}
// Avoid feeding long recordings to a synchronous WASM inference on mobile.
// Select a 10 s (or shorter) window with the highest mean-square signal energy.
function loudWindow(pcm,sampleRate){
 const size=Math.min(pcm.length,Math.round(10*sampleRate));
 if(pcm.length<=size)return {pcm,startS:0};
 const hop=Math.max(1,Math.floor(sampleRate));
 let best=-1,bestStart=0;
 // Prefix energy on 0.1 second bins to avoid an O(N * window) search.
 const bin=Math.max(1,Math.floor(sampleRate/10));
 const arr=[];
 for(let i=0;i<pcm.length;i+=bin){let sum=0;for(let j=i;j<Math.min(i+bin,pcm.length);j++)sum+=pcm[j]*pcm[j];arr.push(sum);}
 const nBins=Math.max(1,Math.floor(size/bin));
 let active=0;
 for(let i=0;i<nBins;i++)active+=arr[i]||0;
 for(let b=0;b<=arr.length-nBins;b+=10){
   if(b>0){for(let k=b-10;k<b;k++)active-=arr[k]||0;for(let k=b+nBins-10;k<b+nBins;k++)active+=arr[k]||0;}
   if(active>best){best=active;bestStart=b*bin;}
 }
 const start=Math.min(bestStart,pcm.length-size);
 return {pcm:pcm.subarray(start,start+size),startS:Math.round(start/sampleRate*10)/10};
}
function barRow(label,score){
 const row=document.createElement('div');row.className='ai-score';
 const name=document.createElement('span');name.textContent=humanLabel(label);
 name.title=label;
 const track=document.createElement('span');track.className='bar';
 const bar=document.createElement('i');bar.style.width=`${Math.min(100,Math.max(0,score*100))}%`;
 track.appendChild(bar);
 const num=document.createElement('span');num.className='score';num.textContent=(score*100).toFixed(1)+'%';
 row.append(name,track,num);return row;
}
function render(scores,startS){
 const map=new Map(scores.map(x=>[x.label,x.score]));
 const vocal=DOG_SOUND_NAMES.map(label=>({label,score:map.get(label)||0})).sort((a,b)=>b.score-a.score);
 const topVocal=vocal[0];
 const dogAny=Math.max(...DOG_CONTEXT_NAMES.map(label=>map.get(label)||0), ...vocal.map(x=>x.score));
 const anyDog=dogAny>=0.08;
 const strongest=scores[0]||{label:'不明',score:0};
 $('aiHeadline').textContent=anyDog?(topVocal.score>=0.06?humanLabel(topVocal.label):'犬の音を検出（発声の種類は不明）'):'犬の鳴き声を明確に検出できませんでした';
 $('aiDescription').textContent=anyDog?'犬の声と関連する音響イベントの推定です。行動や感情を意味するものではありません。':'犬の声が小さい、環境音が大きい、または学習済みモデルが識別できない可能性があります。';
 $('aiDogScores').replaceChildren(...vocal.map(x=>barRow(x.label,x.score)));
 $('aiTopScores').replaceChildren(...scores.slice(0,5).map(x=>barRow(x.label,x.score)));
 $('aiWindow').textContent=`解析区間：録音開始から約${startS.toFixed(1)}秒後の最大10秒間（音量エネルギーの大きい区間）。スコアは時間窓の最大値で、合計100%にはなりません。`;
 $('aiResults').hidden=false;
 window.CanineLab?.setAIResult({model:MODEL_NAME,topLabel:strongest.label,topScore:Number(strongest.score.toFixed(4)),dogLabel:anyDog&&topVocal.score>=0.06?topVocal.label:'undetermined',dogScore:Number(topVocal.score.toFixed(4)),startS});
}
$('classifyAI').addEventListener('click',async()=>{
 if(busy)return;
 const blob=window.CanineLab?.getLatestAudio();
 if(!blob){showStatus('先に録音するか音声ファイルを読み込んでください。','error');return;}
 busy=true;setReady(false);$('classifyAI').textContent='AI分類中…';
 try{
   const model=await loadModel();
   showStatus('音声を端末内で分類しています…');
   const existing=window.CanineLab?.getLatestPCM();
   const {pcm,sampleRate}=existing || await decodeToMono(blob);
   const windowed=loudWindow(pcm,sampleRate);
   // MediaPipe resamples when sample rate is provided (official Web Audio Classifier API).
   const output=model.classify(windowed.pcm,sampleRate);
   const scores=dedupeCategories(output);
   if(!scores.length)throw new Error('AIモデルが分類スコアを返しませんでした');
   render(scores,windowed.startS);
   showStatus('既存学習済みモデルによる分類が完了しました。必要に応じて記録を保存してください。','success');
 }catch(e){
   console.error('YAMNet classification failed',e);
   showStatus('AI分類できませんでした：'+(e.message||String(e))+'。インターネット接続を確認して、再実行してください。','error');
   $('modelReset').hidden=false;
 }finally{busy=false;$('classifyAI').textContent='この音声をAI分類';setReady(!!window.CanineLab?.getLatestAudio());}
});
$('modelReset').addEventListener('click',()=>{aiClassifier=null;loadingPromise=null;$('modelReset').hidden=true;showStatus('モデルを再読み込みできます。');});
