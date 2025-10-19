const emptyLine = /^\s*$/;
const oneLineComment = /\/\/.*/;
const oneLineMultiLineComment = /\/\*.*?\*\//;
const openMultiLineComment = /\/\*+[^\*\/]*$/;
const closeMultiLineComment = /^[\*\/]*\*+\//;

const SourceLine = require('./SourceLine');
const FileStorage = require('./FileStorage');
const Clone = require('./Clone');

const DEFAULT_CHUNKSIZE = 5;

class CloneDetector {
  #myChunkSize = Number(process.env.CHUNKSIZE) || DEFAULT_CHUNKSIZE;
  #myFileStore = FileStorage.getInstance();

  constructor() {}

  // --------------------
  // Private helpers
  // --------------------
  #filterLines(file) {
    const lines = file.contents.split('\n');
    let inMultiLineComment = false;
    file.lines = [];

    for (let i = 0; i < lines.length; i++) {
      let line = lines[i];

      if (inMultiLineComment) {
        if (-1 != line.search(closeMultiLineComment)) {
          line = line.replace(closeMultiLineComment, '');
          inMultiLineComment = false;
        } else {
          line = '';
        }
      }

      line = line.replace(emptyLine, '');
      line = line.replace(oneLineComment, '');
      line = line.replace(oneLineMultiLineComment, '');

      if (-1 != line.search(openMultiLineComment)) {
        line = line.replace(openMultiLineComment, '');
        inMultiLineComment = true;
      }

      file.lines.push(new SourceLine(i + 1, line.trim()));
    }
    return file;
  }

  #getContentLines(file) {
    return file.lines.filter((line) => line.hasContent());
  }

  #chunkify(file) {
    const chunkSize = this.#myChunkSize;
    const lines = this.#getContentLines(file);
    file.chunks = [];

    for (let i = 0; i <= lines.length - chunkSize; i++) {
      const chunk = lines.slice(i, i + chunkSize);
      file.chunks.push(chunk);
    }
    return file;
  }

  #chunkMatch(first, second) {
    if (first.length !== second.length) return false;
    for (let i = 0; i < first.length; i++) {
      if (!first[i].equals(second[i])) return false;
    }
    return true;
  }

  /**
   * Step 1: create clone candidates from equal chunks.
   * Each candidate is a Clone with one target (compareFile).
   */
  #filterCloneCandidates(file, compareFile) {
    file.instances = file.instances || [];

    for (const chunk of file.chunks) {
      for (const other of compareFile.chunks) {
        if (this.#chunkMatch(chunk, other)) {
          try {
            // NOTE: Clone wants chunks, not line numbers
            const clone = new Clone(file.name, compareFile.name, chunk, other);
            file.instances.push(clone);
          } catch (err) {
            console.error('Clone creation failed:', err.message);
          }
        }
      }
    }
    return file;
  }

  /**
   * Step 2: expand candidates.
   * If two candidates are consecutive sliding-window matches, merge them
   * into one longer clone (using Clone.maybeExpandWith).
   *
   * We expand per-target-file to avoid mixing different compare files.
   */
  #expandCloneCandidates(file) {
    if (!file.instances || file.instances.length === 0) return file;

    // group by target file name (each candidate currently has exactly one target)
    const byTarget = new Map();
    for (const c of file.instances) {
      const targetName = (c.targets && c.targets[0] && c.targets[0].name) || '__unknown__';
      if (!byTarget.has(targetName)) byTarget.set(targetName, []);
      byTarget.get(targetName).push(c);
    }

    const expanded = [];

    for (const [, clones] of byTarget) {
      // sort by source start line so consecutive windows come in order
      clones.sort((a, b) => a.sourceStart - b.sourceStart);

      let current = null;
      for (const cand of clones) {
        if (!current) {
          current = cand;
          continue;
        }
        // uses Clone.isNext + maybeExpandWith (checks sliding-window adjacency on source)
        if (!current.maybeExpandWith(cand)) {
          // not extendable -> keep current and move on
          expanded.push(current);
          current = cand;
        }
      }
      if (current) expanded.push(current);
    }

    file.instances = expanded;
    return file;
  }

  /**
   * Step 3: consolidate duplicates.
   * If we ended up with several clones that have the same source range,
   * merge their targets together to keep one entry.
   */
  #consolidateClones(file) {
    if (!file.instances || file.instances.length === 0) return file;

    const map = new Map();
    for (const c of file.instances) {
      const key = `${c.sourceName}:${c.sourceStart}-${c.sourceEnd}`;
      if (map.has(key)) {
        // add/merge targets from duplicate into existing one
        map.get(key).addTarget(c);
      } else {
        map.set(key, c);
      }
    }

    file.instances = Array.from(map.values());
    return file;
  }

  // --------------------
  // Public API used by index.js
  // --------------------
  preprocess(file) {
    return new Promise((resolve, reject) => {
      if (!file.name.endsWith('.java')) {
        reject(file.name + ' is not a java file. Discarding.');
      } else if (this.#myFileStore.isFileProcessed(file.name)) {
        reject(file.name + ' has already been processed.');
      } else {
        resolve(file);
      }
    });
  }

  transform(file) {
    file = this.#filterLines(file);
    file = this.#chunkify(file);
    return file;
  }

  matchDetect(file) {
    const allFiles = this.#myFileStore.getAllFiles();
    file.instances = file.instances || [];

    for (const f of allFiles) {
      file = this.#filterCloneCandidates(file, f);
      file = this.#expandCloneCandidates(file);
      // consolidation is done after each compare file to keep the list small
      file = this.#consolidateClones(file);
    }
    return file;
  }

  pruneFile(file) {
    delete file.lines;
    delete file.instances;
    return file;
  }

  storeFile(file) {
    this.#myFileStore.storeFile(this.pruneFile(file));
    return file;
  }

  get numberOfProcessedFiles() {
    return this.#myFileStore.numberOfFiles;
  }
}

module.exports = CloneDetector;
