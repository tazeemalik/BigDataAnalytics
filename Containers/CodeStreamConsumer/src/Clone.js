class Clone {
  constructor(sourceName, sourceStart, sourceEnd, targetName, targetStart, targetEnd) {
    this.sourceName = sourceName;
    this.sourceStart = sourceStart;
    this.sourceEnd = sourceEnd;
    this.targetName = targetName;
    this.targetStart = targetStart;
    this.targetEnd = targetEnd;
  }

  equals(clone) {
    return (
      this.sourceName === clone.sourceName &&
      this.sourceStart === clone.sourceStart &&
      this.sourceEnd === clone.sourceEnd &&
      this.targetName === clone.targetName &&
      this.targetStart === clone.targetStart &&
      this.targetEnd === clone.targetEnd
    );
  }
}

module.exports = Clone;
