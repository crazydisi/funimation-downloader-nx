import got from 'got';
import fs from 'fs';
import { GithubTag, TagCompare } from '../@types/github';
import path from 'path';
import { UpdateFile } from '../@types/updateFile';
import packageJson from '../package.json';
import { CompilerOptions, transpileModule } from 'typescript';
import tsConfig from '../tsconfig.json';
import fsextra from 'fs-extra';
import seiHelper from 'sei-helper';
const workingDir = (process as NodeJS.Process & {
  pkg?: unknown
}).pkg ? path.dirname(process.execPath) : path.join(__dirname, '/..');
const updateFilePlace = path.join(workingDir, 'config', 'updates.json');

const updateIgnore = [
  '*.d.ts',
  '.git',
  'lib',
  'node_modules',
  '@types',
  path.join('bin', 'mkvtoolnix'),
  path.join('config', 'token.yml'),
  '.eslint',
  'tsconfig.json',
  'updates.json',
  'tsc.ts'
];

const askBeforeUpdate = [
  '*.yml'
];

enum ApplyType {
  DELETE, ADD, UPDATE
} 

export type ApplyItem = {
  type: ApplyType,
  path: string,
  content: string
}

export default (async (force = false) => {
  const isPackaged = (process as NodeJS.Process & {
    pkg?: unknown
  }).pkg ? true : false;
  if (isPackaged) {
    return;
  }
  let updateFile: UpdateFile|undefined;
  if (fs.existsSync(updateFilePlace)) {
    updateFile = JSON.parse(fs.readFileSync(updateFilePlace).toString()) as UpdateFile;
    if (new Date() < new Date(updateFile.nextCheck) && !force) {
      return;
    }
  }
  console.log('Checking for updates...');
  const tagRequest = await got('https://api.github.com/repos/anidl/multi-downloader-nx/tags');
  const tags = JSON.parse(tagRequest.body) as GithubTag[];

  if (tags.length > 0) {
    const newer = tags.filter(a => {
      return isNewer(packageJson.version, a.name);
    });
    console.log(`Found ${tags.length} release tags and ${newer.length} that are new.`);
  
    if (newer.length < 1) {
      console.log('[INFO] No new tags found');
      return done();
    }
    const newest = newer.sort((a, b) => a.name < b.name ? 1 : a.name > b.name ? -1 : 0)[0];
    const compareRequest = await got(`https://api.github.com/repos/anidl/multi-downloader-nx/compare/${packageJson.version}...${newest.name}`);

    const compareJSON = JSON.parse(compareRequest.body) as TagCompare;

    console.log(`You are behind by ${compareJSON.ahead_by} releases!`);
    const changedFiles = compareJSON.files.map(a => ({
      ...a,
      filename: path.join(...a.filename.split('/'))
    })).filter(a => {
      return !updateIgnore.some(_filter => matchString(_filter, a.filename));
    });
    if (changedFiles.length < 1) {
      console.log('[INFO] No file changes found... updating package.json. If you think this is an error please get the newst version yourself.');
      return done(newest.name);
    }
    console.log(`Found file changes: \n${changedFiles.map(a => `  [${
      a.status === 'modified' ? '*' : a.status === 'added' ? '+' : '-'
    }] ${a.filename}`).join('\n')}`);

    const remove: string[] = [];

    changedFiles.filter(a => a.status !== 'added').forEach(async a => {
      if (!askBeforeUpdate.some(pattern => matchString(pattern, a.filename)))
        return;
      const answer = await seiHelper.question(`The developer decided that the file '${a.filename}' may contain information you changed yourself. Should they be overriden to be updated? [y/N]`);
      if (answer.toLowerCase() === 'y')
        remove.push(a.sha);
    });

    const changesToApply = await Promise.all(changedFiles.filter(a => !remove.includes(a.sha)).map(async (a): Promise<ApplyItem> => {
      if (a.filename.endsWith('.ts')) {
        const ret = {
          path: a.filename.slice(0, -2) + 'js',
          content: transpileModule((await got(a.raw_url)).body, {
            compilerOptions: tsConfig.compilerOptions as unknown as CompilerOptions
          }).outputText,
          type: a.status === 'modified' ? ApplyType.UPDATE : a.status === 'added' ? ApplyType.ADD : ApplyType.DELETE
        };
        console.log('✓ transpiled %s', ret.path);
        return ret;
      } else {
        const ret = {
          path: a.filename,
          content: (await got(a.raw_url)).body,
          type: a.status === 'modified' ? ApplyType.UPDATE : a.status === 'added' ? ApplyType.ADD : ApplyType.DELETE
        };
        console.log('✓ transpiled %s', ret.path);
        return ret;
      }
    }));

    changesToApply.forEach(a => {
      fsextra.ensureDirSync(path.dirname(a.path));
      fs.writeFileSync(path.join(__dirname, '..', a.path), a.content);
      console.log('✓ written %s', a.path);
    });

    console.log('[INFO] Done');
    return done();
  } 
});

function done(newVersion?: string) {
  const next = new Date(Date.now() + 1000 * 60 * 60 * 24);
  fs.writeFileSync(updateFilePlace, JSON.stringify({
    lastCheck: Date.now(),
    nextCheck: next.getTime()
  } as UpdateFile, null, 2));
  if (newVersion) {
    fs.writeFileSync('../package.json', JSON.stringify({
      ...packageJson,
      version: newVersion
    }, null, 4));
  }
  console.log('[INFO] Searching for update finished. Next time running on the ' + next.toLocaleDateString() + ' at ' + next.toLocaleTimeString() + '.');
}

function isNewer(curr: string, compare: string) : boolean {
  const currParts = curr.split('.').map(a => parseInt(a));
  const compareParts = compare.split('.').map(a => parseInt(a));

  for (let i = 0; i < Math.max(currParts.length, compareParts.length); i++) {
    if (currParts.length <= i)
      return true;
    if (compareParts.length <= i)
      return false;
    if (currParts[i] !== compareParts[i])
      return compareParts[i] > currParts[i];
  }

  return false;
}

function matchString(pattern: string, toMatch: string) : boolean {
  const filter = path.join('..', pattern);
  if (pattern.startsWith('*')) {
    return toMatch.endsWith(pattern.slice(1));
  } else if (filter.split(path.sep).pop()?.indexOf('.') === -1) {
    return toMatch.startsWith(filter);
  } else {
    return toMatch.split(path.sep).pop() === pattern;
  }
}