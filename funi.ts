// modules build-in
import fs from 'fs';
import path from 'path';

// package json
import packageJson from './package.json'; 

// program name
const api_host = 'https://prod-api-funimationnow.dadcdigital.com/api';

// modules extra
import * as shlp from 'sei-helper';
import m3u8 from 'm3u8-parsed';
import hlsDownload from 'hls-download';

// extra
import * as appYargs from './modules/module.app-args';
import * as yamlCfg from './modules/module.cfg-loader';
import vttConvert from './modules/module.vttconvert';

// types
import { Item } from './@types/items';

// params
const cfg = yamlCfg.loadCfg();
const token = yamlCfg.loadFuniToken();
// cli
const argv = appYargs.appArgv(cfg.cli);
// Import modules after argv has been exported
import getData from './modules/module.getdata.js';
import merger from './modules/module.merger';
import parseSelect from './modules/module.parseSelect';
import { EpisodeData, MediaChild } from './@types/episode';
import { Subtitle } from './@types/funiTypes';
import { StreamData } from './@types/streamData';
import { DownloadedFile } from './@types/downloadedFile';
import parseFileName, { Variable } from './modules/module.filename';
import { downloaded } from './modules/module.downloadArchive';
import { FunimationMediaDownload } from './@types/funiTypes';
import * as langsData from './modules/module.langsData';
import { TitleElement } from './@types/episode';
import { AvailableFilenameVars } from './modules/module.args';
// check page
argv.p = 1;

// fn variables
let  fnEpNum: string|number = 0,
  fnOutput: string[] = [],
  season = 0,
  tsDlPath: {
    path: string,
    lang: langsData.LanguageItem
  }[] = [],
  stDlPath: Subtitle[] = [];

// main
export default (async () => {
  // load binaries
  console.log(`\n=== Multi Downloader NX ${packageJson.version} ===\n`);
  cfg.bin = await yamlCfg.loadBinCfg();
  if (argv.allDubs) {
    argv.dubLang = langsData.dubLanguageCodes;
  }
  // select mode
  if (argv.silentAuth && !argv.auth) {
    await auth();
  }
  if(argv.auth){
    auth();
  }
  else if(argv.search){
    searchShow();
  }
  else if(argv.s && !isNaN(parseInt(argv.s)) && parseInt(argv.s) > 0){
    return getShow();
  }
  else{
    appYargs.showHelp();
  }
});

// auth
async function auth(){
  const authOpts = {
    user: argv.username ?? await shlp.question('[Q] LOGIN/EMAIL'),
    pass: argv.password ?? await shlp.question('[Q] PASSWORD   ')
  };
  const authData =  await getData({
    baseUrl: api_host,
    url: '/auth/login/',
    auth: authOpts,
    debug: argv.debug,
  });
  if(authData.ok && authData.res){
    const resJSON = JSON.parse(authData.res.body);
    if(resJSON.token){
      console.log('[INFO] Authentication success, your token: %s%s\n', resJSON.token.slice(0,8),'*'.repeat(32));
      yamlCfg.saveFuniToken({'token': resJSON.token});
    } else {
      console.log('[ERROR]%s\n', ' No token found');
      if (argv.debug) {
        console.log(resJSON);
      }
      process.exit(1);
    }
  }
}

// search show
async function searchShow(){
  const qs = {unique: true, limit: 100, q: argv.search, offset: 0 };
  const searchData = await getData({
    baseUrl: api_host,
    url: '/source/funimation/search/auto/',
    querystring: qs,
    token: token,
    useToken: true,
    debug: argv.debug,
  });
  if(!searchData.ok || !searchData.res){return;}
  const searchDataJSON = JSON.parse(searchData.res.body);
  if(searchDataJSON.detail){
    console.log(`[ERROR] ${searchDataJSON.detail}`);
    return;
  }
  if(searchDataJSON.items && searchDataJSON.items.hits){
    const shows = searchDataJSON.items.hits;
    console.log('[INFO] Search Results:');
    for(const ssn in shows){
      console.log(`[#${shows[ssn].id}] ${shows[ssn].title}` + (shows[ssn].tx_date?` (${shows[ssn].tx_date})`:''));
    }
  }
  console.log('[INFO] Total shows found: %s\n',searchDataJSON.count);
}

// get show
async function getShow(){
  let ok = true;
  const showData = await getData({
    baseUrl: api_host,
    url: `/source/catalog/title/${argv.s}`,
    token: token,
    useToken: true,
    debug: argv.debug,
  });
    // check errors
  if(!showData.ok || !showData.res){return;}
  const showDataJSON = JSON.parse(showData.res.body);
  if(showDataJSON.status){
    console.log('[ERROR] Error #%d: %s\n', showDataJSON.status, showDataJSON.data.errors[0].detail);
    process.exit(1);
  }
  else if(!showDataJSON.items || showDataJSON.items.length<1){
    console.log('[ERROR] Show not found\n');
    process.exit(0);
  }
  const showDataItem = showDataJSON.items[0];
  console.log('[#%s] %s (%s)',showDataItem.id,showDataItem.title,showDataItem.releaseYear);
  // show episodes
  const qs: {
        limit: number,
        sort: string,
        sort_direction: string,
        title_id: number,
        language?: string
    } = { limit: -1, sort: 'order', sort_direction: 'ASC', title_id: parseInt(argv.s as string) };
  if(argv.alt){ qs.language = 'English'; }
  const episodesData = await getData({
    baseUrl: api_host,
    url: '/funimation/episodes/',
    querystring: qs,
    token: token,
    useToken: true,
    debug: argv.debug,
  });
  if(!episodesData.ok || !episodesData.res){return;}
    
  let epsDataArr: Item[] = JSON.parse(episodesData.res.body).items;
  const epNumRegex = /^([A-Z0-9]*[A-Z])?(\d+)$/i;
  const epSelEpsTxt = []; let typeIdLen = 0, epIdLen = 4;
    
  const parseEpStr = (epStr: string) => {
    const match = epStr.match(epNumRegex);
    if (!match) {
      console.error('[ERROR] No match found');
      return ['', ''];
    }
    if(match.length > 2){
      const spliced = [...match].splice(1);
      spliced[0] = spliced[0] ? spliced[0] : '';
      return spliced;
    }
    else return [ '', match[0] ];
  };
    
  epsDataArr = epsDataArr.map(e => {
    const baseId = e.ids.externalAsianId ? e.ids.externalAsianId : e.ids.externalEpisodeId;
    e.id = baseId.replace(new RegExp('^' + e.ids.externalShowId), '');
    if(e.id.match(epNumRegex)){
      const epMatch = parseEpStr(e.id);
      epIdLen = epMatch[1].length > epIdLen ? epMatch[1].length : epIdLen;
      typeIdLen = epMatch[0].length > typeIdLen ? epMatch[0].length : typeIdLen;
      e.id_split = epMatch;
    }
    else{
      typeIdLen = 3 > typeIdLen? 3 : typeIdLen;
      console.log('[ERROR] FAILED TO PARSE: ', e.id);
      e.id_split = [ 'ZZZ', 9999 ];
    }
    return e;
  });
    
  const epSelList = parseSelect(argv.e as string, argv.but);

  const fnSlug: {
    title: string,
    episode: string,
    episodeID: string
  }[] = []; let is_selected = false;
    
  const eps = epsDataArr;
  epsDataArr.sort((a, b) => {
    if (a.item.seasonOrder < b.item.seasonOrder && a.id.localeCompare(b.id) < 0) {
      return -1;
    }
    if (a.item.seasonOrder > b.item.seasonOrder && a.id.localeCompare(b.id) > 0) {
      return 1;
    }
    return 0;
  });
    
  for(const e in eps){
    eps[e].id_split[1] = parseInt(eps[e].id_split[1].toString()).toString().padStart(epIdLen, '0');
    let epStrId = eps[e].id_split.join('');
    // select
    is_selected = false;
    if (argv.all || epSelList.isSelected(epStrId)) {
      fnSlug.push({title:eps[e].item.titleSlug,episode:eps[e].item.episodeSlug, episodeID:epStrId});
      epSelEpsTxt.push(epStrId);
      is_selected = true;
    }
    else{
      is_selected = false;
    }
    // console vars
    const tx_snum = eps[e].item.seasonNum=='1'?'':` S${eps[e].item.seasonNum}`;
    const tx_type = eps[e].mediaCategory != 'episode' ? eps[e].mediaCategory : '';
    const tx_enum = eps[e].item.episodeNum && eps[e].item.episodeNum !== '' ?
      `#${(parseInt(eps[e].item.episodeNum) < 10 ? '0' : '')+eps[e].item.episodeNum}` : '#'+eps[e].item.episodeId;
    const qua_str = eps[e].quality.height ? eps[e].quality.quality + eps[e].quality.height : 'UNK';
    const aud_str = eps[e].audio.length > 0 ? `, ${eps[e].audio.join(', ')}` : '';
    const rtm_str = eps[e].item.runtime !== '' ? eps[e].item.runtime : '??:??';
    // console string
    eps[e].id_split[0] = eps[e].id_split[0].toString().padStart(typeIdLen, ' ');
    epStrId = eps[e].id_split.join('');
    let conOut  = `[${epStrId}] `;
    conOut += `${eps[e].item.titleName+tx_snum} - ${tx_type+tx_enum} ${eps[e].item.episodeName} `;
    conOut += `(${rtm_str}) [${qua_str+aud_str}]`;
    conOut += is_selected ? ' (selected)' : '';
    conOut += eps.length-1 == parseInt(e) ? '\n' : '';
    console.log(conOut);
  }
  if(fnSlug.length < 1){
    console.log('[INFO] Episodes not selected!\n');
    return;
  }
  else{
    console.log('[INFO] Selected Episodes: %s\n',epSelEpsTxt.join(', '));
    for(let fnEp=0;fnEp<fnSlug.length;fnEp++){
      if (await getEpisode(fnSlug[fnEp]) !== true)
        ok = false;
    }
  }
  return ok;
}

async function getEpisode(fnSlug: {
  title: string,
  episode: string,
  episodeID: string
}) {
  const episodeData = await getData({
    baseUrl: api_host,
    url: `/source/catalog/episode/${fnSlug.title}/${fnSlug.episode}/`,
    token: token,
    useToken: true,
    debug: argv.debug,
  });
  if(!episodeData.ok || !episodeData.res){return;}
  const ep = JSON.parse(episodeData.res.body).items[0] as EpisodeData, streamIds = [];
  // build fn
  season = parseInt(ep.parent.seasonNumber);
  if(ep.mediaCategory != 'Episode'){
    ep.number = ep.number !== '' ? ep.mediaCategory+ep.number : ep.mediaCategory+'#'+ep.id;
  }
  fnEpNum = isNaN(parseInt(ep.number)) ? ep.number : parseInt(ep.number);
    
  // is uncut
  const uncut = {
    Japanese: false,
    English: false
  };
    
  // end
  console.log(
    '[INFO] %s - S%sE%s - %s',
    ep.parent.title,
    (ep.parent.seasonNumber ? ep.parent.seasonNumber : '?'),
    (ep.number ? ep.number : '?'),
    ep.title
  );
    
  console.log('[INFO] Available streams (Non-Encrypted):');
    
  // map medias
  const media = ep.media.map(function(m){
    if(m.mediaType == 'experience'){
      if(m.version.match(/uncut/i) && m.language){
        uncut[m.language] = true;
      }
      return {
        id: m.id,
        language: m.language,
        version: m.version,
        type: m.experienceType,
        subtitles: getSubsUrl(m.mediaChildren, m.language)
      };
    }
    else{
      return { id: 0, type: '' };
    }
  });
    
  // select
  stDlPath = [];
  for(const m of media){
    let selected = false;
    if(m.id > 0 && m.type == 'Non-Encrypted'){
      const dub_type = m.language;
      if (!dub_type)
        continue;
      let localSubs: Subtitle[] = [];
      const selUncut = !argv.simul && uncut[dub_type] && m.version?.match(/uncut/i) 
        ? true 
        : (!uncut[dub_type] || argv.simul && m.version?.match(/simulcast/i) ? true : false);
      for (const curDub of argv.dubLang) {
        const item = langsData.languages.find(a => a.code === curDub);
        if(item && dub_type == (item.funi_name || item.name) && selUncut){
          streamIds.push({
            id: m.id,
            lang: item
          });
          stDlPath.push(...m.subtitles);
          localSubs = m.subtitles;
          selected = true;
        }
      }
      console.log(`[#${m.id}] ${dub_type} [${m.version}]${(selected?' (selected)':'')}${
        localSubs && localSubs.length > 0 && selected ? ` (using ${localSubs.map(a => `'${a.lang.name}'`).join(', ')} for subtitles)` : ''
      }`);
    }
  }

  const already: string[] = [];
  stDlPath = stDlPath.filter(a => {
    if (already.includes(`${a.closedCaption ? 'cc' : ''}-${a.lang.code}`)) {
      return false;
    } else {
      already.push(`${a.closedCaption ? 'cc' : ''}-${a.lang.code}`);
      return true;
    }
  });
  if(streamIds.length < 1){
    console.log('[ERROR] Track not selected\n');
    return;
  }
  else{
    tsDlPath = [];
    for (const streamId of streamIds) {
      const streamData = await getData({
        baseUrl: api_host,
        url: `/source/catalog/video/${streamId.id}/signed`,
        token: token,
        dinstid: 'uuid',
        useToken: true,
        debug: argv.debug,
      });
      if(!streamData.ok || !streamData.res){return;}
      const streamDataRes = JSON.parse(streamData.res.body) as StreamData;
      if(streamDataRes.errors){
        console.log('[ERROR] Error #%s: %s\n',streamDataRes.errors[0].code,streamDataRes.errors[0].detail);
        return;
      }
      else{
        for(const u in streamDataRes.items){
          if(streamDataRes.items[u].videoType == 'm3u8'){
            tsDlPath.push({
              path: streamDataRes.items[u].src,
              lang: streamId.lang
            });
            break;
          }
        }
      }
    }
    if(tsDlPath.length < 1){
      console.log('[ERROR] Unknown error\n');
      return;
    }
    else{
      const res = await downloadStreams({
        id: fnSlug.episodeID,
        title: ep.title,
        showTitle: ep.parent.title
      });
      if (res === true) {
        downloaded({
          service: 'funi',
          type: 's'
        }, argv.s as string, [fnSlug.episodeID]);
      }
      return res;
    }
  }
}

function getSubsUrl(m: MediaChild[], parentLanguage: TitleElement|undefined) : Subtitle[] {
  if((argv.nosubs && !argv.sub) || argv.dlsubs.includes('none')){
    return [];
  }

  const found: Subtitle[] = [];

  const media = m.filter(a => a.filePath.split('.').pop() === 'vtt');
  for (const me of media) {
    const lang = langsData.languages.find(a => me.language === (a.funi_name || a.name));
    if (!lang) {
      continue;
    }
    const pLang = langsData.languages.find(a => (a.funi_name || a.name) === parentLanguage);
    if (argv.dlsubs.includes('all') || argv.dlsubs.some(a => a === lang.locale)) {
      found.push({
        url: me.filePath,
        ext: `.${lang.code}${pLang?.code === lang.code ? '.cc' : ''}`,
        lang,
        closedCaption: pLang?.code === lang.code
      });
    }
  }

  return found;
}

async function downloadStreams(epsiode: FunimationMediaDownload){
    
  // req playlist

  const purvideo: DownloadedFile[] = [];
  const puraudio: DownloadedFile[] = [];
  const audioAndVideo: DownloadedFile[] = []; 
  for (const streamPath of tsDlPath) {
    const plQualityReq = await getData({
      url: streamPath.path,
      debug: argv.debug,
    });
    if(!plQualityReq.ok || !plQualityReq.res){return;}
        
    const plQualityLinkList = m3u8(plQualityReq.res.body);
        
    const mainServersList = [
      'vmfst-api.prd.funimationsvc.com',
      'd33et77evd9bgg.cloudfront.net',
      'd132fumi6di1wa.cloudfront.net',
      'funiprod.akamaized.net',
    ];
        
    const plServerList: string[] = [],
      plStreams: Record<string|number, {
      [key: string]: string   
    }> = {},
      plLayersStr  = [],
      plLayersRes: Record<string|number, {
      width: number,
      height: number
    }>  = {};
    let plMaxLayer   = 1,
      plNewIds     = 1,
      plAud: undefined|{
      uri: string
      language: langsData.LanguageItem
    };
        
    // new uris
    const vplReg = /streaming_video_(\d+)_(\d+)_(\d+)_index\.m3u8/;
    if(plQualityLinkList.playlists[0].uri.match(vplReg)){
      const audioKey = Object.keys(plQualityLinkList.mediaGroups.AUDIO).pop();
      if (!audioKey)
        return console.log('[ERROR] No audio key found');
      if(plQualityLinkList.mediaGroups.AUDIO[audioKey]){
        const audioDataParts = plQualityLinkList.mediaGroups.AUDIO[audioKey],
          audioEl = Object.keys(audioDataParts);
        const audioData = audioDataParts[audioEl[0]];
        let language = langsData.languages.find(a => a.locale === audioData.language);
        if (!language) {
          language = langsData.languages.find(a => a.funi_name || a.name === audioEl[0]);
          if (!language) {
            console.log(`[ERROR] Unable to find language for locale ${audioData.language} or name ${audioEl[0]}`);
            return;
          }
        }
        plAud = {
          uri: audioData.uri,
          language: language
        };
      }
      plQualityLinkList.playlists.sort((a, b) => {
        const aMatch = a.uri.match(vplReg), bMatch = b.uri.match(vplReg);
        if (!aMatch || !bMatch) {
          console.log('[ERROR] Unable to match');
          return 0;
        }
        const av = parseInt(aMatch[3]);
        const bv = parseInt(bMatch[3]);
        if(av  > bv){
          return 1;
        }
        if (av < bv) {
          return -1;
        }
        return 0;
      });
    }
        
    for(const s of plQualityLinkList.playlists){
      if(s.uri.match(/_Layer(\d+)\.m3u8/) || s.uri.match(vplReg)){
        // set layer and max layer
        let plLayerId: number|string = 0;
        const match = s.uri.match(/_Layer(\d+)\.m3u8/);
        if(match){
          plLayerId = parseInt(match[1]);
        }
        else{
          plLayerId = plNewIds, plNewIds++;
        }
        plMaxLayer    = plMaxLayer < plLayerId ? plLayerId : plMaxLayer;
        // set urls and servers
        const plUrlDl  = s.uri;
        const plServer = new URL(plUrlDl).host;
        if(!plServerList.includes(plServer)){
          plServerList.push(plServer);
        }
        if(!Object.keys(plStreams).includes(plServer)){
          plStreams[plServer] = {};
        }
        if(plStreams[plServer][plLayerId] && plStreams[plServer][plLayerId] != plUrlDl){
          console.log(`[WARN] Non duplicate url for ${plServer} detected, please report to developer!`);
        }
        else{
          plStreams[plServer][plLayerId] = plUrlDl;
        }
        // set plLayersStr
        const plResolution = s.attributes.RESOLUTION;
        plLayersRes[plLayerId] = plResolution;
        const plBandwidth  = Math.round(s.attributes.BANDWIDTH/1024);
        if(plLayerId<10){
          plLayerId = plLayerId.toString().padStart(2,' ');
        }
        const qualityStrAdd   = `${plLayerId}: ${plResolution.width}x${plResolution.height} (${plBandwidth}KiB/s)`;
        const qualityStrRegx  = new RegExp(qualityStrAdd.replace(/(:|\(|\)|\/)/g,'\\$1'),'m');
        const qualityStrMatch = !plLayersStr.join('\r\n').match(qualityStrRegx);
        if(qualityStrMatch){
          plLayersStr.push(qualityStrAdd);
        }
      }
      else {
        console.log(s.uri);
      }
    }

    for(const s of mainServersList){
      if(plServerList.includes(s)){
        plServerList.splice(plServerList.indexOf(s), 1);
        plServerList.unshift(s);
        break;
      }
    }

        
    const plSelectedServer = plServerList[argv.x-1];
    const plSelectedList   = plStreams[plSelectedServer];
        
    plLayersStr.sort();
    console.log(`[INFO] Servers available:\n\t${plServerList.join('\n\t')}`);
    console.log(`[INFO] Available qualities:\n\t${plLayersStr.join('\n\t')}`);

    const selectedQuality = argv.q === 0 || argv.q > Object.keys(plLayersRes).length
      ? Object.keys(plLayersRes).pop() as string
      : argv.q;
    const videoUrl = argv.x < plServerList.length+1 && plSelectedList[selectedQuality] ? plSelectedList[selectedQuality] : '';

    if(videoUrl != ''){
      console.log(`[INFO] Selected layer: ${selectedQuality} (${plLayersRes[selectedQuality].width}x${plLayersRes[selectedQuality].height}) @ ${plSelectedServer}`);
      console.log('[INFO] Stream URL:',videoUrl);
    
      fnOutput = parseFileName(argv.fileName, ([
        ['episode', isNaN(parseInt(fnEpNum as string)) ? fnEpNum : parseInt(fnEpNum as string)],
        ['title', epsiode.title],
        ['showTitle', epsiode.showTitle],
        ['season', season],
        ['width', plLayersRes[selectedQuality].width],
        ['height', plLayersRes[selectedQuality].height],
        ['service', 'Funimation']
      ] as [AvailableFilenameVars, string|number][]).map((a): Variable => {
        return {
          name: a[0],
          replaceWith: a[1],
          type: typeof a[1],
        } as Variable;
      }), argv.numbers);
      if (fnOutput.length < 1)
        throw new Error(`Invalid path generated for input ${argv.fileName}`);
      console.log(`[INFO] Output filename: ${fnOutput.join(path.sep)}.ts`);
    }
    else if(argv.x > plServerList.length){
      console.log('[ERROR] Server not selected!\n');
      return;
    }
    else{
      console.log('[ERROR] Layer not selected!\n');
      return;
    }
        
    let dlFailed = false;
    let dlFailedA = false;
        
    await fs.promises.mkdir(path.join(cfg.dir.content, ...fnOutput.slice(0, -1)), { recursive: true });

    video: if (!argv.novids) {
      if (plAud && (purvideo.length > 0 || audioAndVideo.length > 0)) {
        break video;
      } else if (!plAud && (audioAndVideo.some(a => a.lang === streamPath.lang) || puraudio.some(a => a.lang === streamPath.lang))) {
        break video;
      }
      // download video
      const reqVideo = await getData({
        url: videoUrl,
        debug: argv.debug,
      });
      if (!reqVideo.ok || !reqVideo.res) { break video; }
            
      const chunkList = m3u8(reqVideo.res.body);
            
      const tsFile = path.join(cfg.dir.content, ...fnOutput.slice(0, -1), `${fnOutput.slice(-1)}.video${(plAud?.uri ? '' : '.' + streamPath.lang.code )}`);
      dlFailed = !await downloadFile(tsFile, chunkList);
      if (!dlFailed) {
        if (plAud) {
          purvideo.push({
            path: `${tsFile}.ts`,
            lang: plAud.language
          });
        } else {
          audioAndVideo.push({
            path: `${tsFile}.ts`,
            lang: streamPath.lang
          });
        }
      }
    }
    else{
      console.log('[INFO] Skip video downloading...\n');
    }
    audio: if (plAud && !argv.noaudio) {
      // download audio
      if (audioAndVideo.some(a => a.lang === plAud?.language) || puraudio.some(a => a.lang === plAud?.language))
        break audio;
      const reqAudio = await getData({
        url: plAud.uri,
        debug: argv.debug,
      });
      if (!reqAudio.ok || !reqAudio.res) { return; }
            
      const chunkListA = m3u8(reqAudio.res.body);
    
      const tsFileA = path.join(cfg.dir.content, ...fnOutput.slice(0, -1), `${fnOutput.slice(-1)}.audio.${plAud.language.code}`);
    
      dlFailedA = !await downloadFile(tsFileA, chunkListA);
      if (!dlFailedA)
        puraudio.push({
          path: `${tsFileA}.ts`,
          lang: plAud.language
        });

    }
  }
    
  // add subs
  const subsExt = !argv.mp4 || argv.mp4 && argv.ass ? '.ass' : '.srt';
  let addSubs = true;

  // download subtitles
  if(stDlPath.length > 0){
    console.log('[INFO] Downloading subtitles...');
    for (const subObject of stDlPath) {
      const subsSrc = await getData({
        url: subObject.url,
        debug: argv.debug,
      });
      if(subsSrc.ok && subsSrc.res){
        const assData = vttConvert(subsSrc.res.body, (subsExt == '.srt' ? true : false), subObject.lang.name, argv.fontSize, argv.fontName);
        subObject.out = path.join(cfg.dir.content, ...fnOutput.slice(0, -1), `${fnOutput.slice(-1)}.subtitle${subObject.ext}${subsExt}`);
        fs.writeFileSync(subObject.out, assData);
      }
      else{
        console.log('[ERROR] Failed to download subtitles!');
        addSubs = false;
        break;
      }
    }
    if (addSubs)
      console.log('[INFO] Subtitles downloaded!');
  }
  
  if((puraudio.length < 1 && audioAndVideo.length < 1) || (purvideo.length < 1 && audioAndVideo.length < 1)){
    console.log('\n[INFO] Unable to locate a video AND audio file\n');
    return;
  }
    
  if(argv.skipmux){
    console.log('[INFO] Skipping muxing...');
    return;
  }
    
  // check exec
  const mergerBin = merger.checkMerger(cfg.bin, argv.mp4, argv.forceMuxer);
    
  if ( argv.novids ){
    console.log('[INFO] Video not downloaded. Skip muxing video.');
  }

  const ffext = !argv.mp4 ? 'mkv' : 'mp4';
  const mergeInstance = new merger({
    onlyAudio: puraudio,
    onlyVid: purvideo,
    output: `${path.join(cfg.dir.content, ...fnOutput)}.${ffext}`,
    subtitles: stDlPath.map(a => {
      return {
        file: a.out as string,
        language: a.lang,
        title: a.lang.name,
        closedCaption: a.closedCaption
      };
    }),
    videoAndAudio: audioAndVideo,
    simul: argv.simul,
    skipSubMux: argv.skipSubMux
  });

  if(mergerBin.MKVmerge){
    const command = mergeInstance.MkvMerge();
    shlp.exec('mkvmerge', `"${mergerBin.MKVmerge}"`, command);
  }
  else if(mergerBin.FFmpeg){
    const command = mergeInstance.FFmpeg();
    shlp.exec('ffmpeg',`"${mergerBin.FFmpeg}"`,command);
  }
  else{
    console.log('\n[INFO] Done!\n');
    return true;
  }
  if (argv.nocleanup) {
    return true;
  }
    
  mergeInstance.cleanUp();
  console.log('\n[INFO] Done!\n');
  return true;
}

async function downloadFile(filename: string, chunkList: {
  segments: Record<string, unknown>[],
}) {
  const downloadStatus = await new hlsDownload({
    m3u8json: chunkList,
    output: `${filename + '.ts'}`,
    timeout: argv.timeout,
    threads: argv.partsize,
    fsRetryTime: argv.fsRetryTime * 1000
  }).download();
    
  return downloadStatus.ok;
}
