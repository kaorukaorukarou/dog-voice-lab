Canine Vocalization Lab v0.3 — 公開済み学習済みAI搭載版

使用方法：
1. ZIPを解凍します。
2. 内部の index.html, app.js, pretrained-ai.js, analysis-worker.js, styles.css,
   sw.js, manifest.webmanifest, icon-180.png, icon-512.png, icon.svg, .nojekyll を
   GitHub の dog-voice-lab リポジトリの最上位にアップロードします。
3. GitHub Pagesの https://ユーザー名.github.io/dog-voice-lab/ をiPhoneのSafariで開きます。
4. 録音または音声ファイルの読み込みを行い、
   「この音声をAI分類」を押します。
5. 吠え、遠吠え、唸り、クンクン鳴き等に関するモデルのスコアを表示します。
6. 録音や解析値を保存し、CSVまたはZIPで書き出せます。

旧v0.2からの変更：
- 公開済みのGoogle YAMNet（AudioSet学習済み）モデルを使った音声イベント分類機能を追加。
- 登録済み録音は、同じGitHub PagesのURL・同じSafari保存場所であれば、IndexedDB（canine-lab-v1）から引き続き読み込めます。
- AIラベル・モデル名・スコア・区間開始位置をCSVに追加しました。
- 音声波形・音響特徴量解析・録音・保存は従来通りです。

制限：
- 「食事が欲しい」「怒っている」などの情動・要求・意味を予測するモデルではありません。
- クラス間スコアは犬の感情の確率を意味しません。
- 初回AI実行時に外部CDNとGoogle提供モデルを読み込みます（要通信）。モデル本体はZIP同梱ではありません。
- AI音声分類のiPhone実機動作は未検証です。録音・基本解析のみ実機確認済み（ユーザー側）。
- クラウドへ録音そのものはアップロードしませんが、MediaPipeライブラリ側の利用状況収集については提供元のプライバシー説明をご確認ください。
- Safariは音声形式によってデコードできない場合があります。

外部依存（端末上の実行）：
@mediapipe/tasks-audio@1.1.0 (Apache 2.0)
https://cdn.jsdelivr.net/npm/@mediapipe/tasks-audio@1.1.0/+esm
Google YAMNet / AudioSet pretrained
https://storage.googleapis.com/mediapipe-models/audio_classifier/yamnet/float32/1/yamnet.tflite

参考：
https://developers.google.com/edge/mediapipe/solutions/audio/audio_classifier/web_js
https://github.com/tensorflow/models/blob/master/research/audioset/yamnet/README.md
