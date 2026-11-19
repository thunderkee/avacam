class CMUDictionary {
    constructor() {
        this.dictionary = new Map();
        this.isLoaded = false;
        this.loadingPromise = null;
    }

    /**
     * Load CMU pronunciation dictionary
     * For MVP, we'll use a subset of common words
     * In production, this would load the full 134MB dictionary
     */
    async load() {
        if (this.isLoaded) return;
        if (this.loadingPromise) return this.loadingPromise;

        this.loadingPromise = this.loadDictionaryData();
        await this.loadingPromise;
        this.isLoaded = true;
    }

    /**
     * Load dictionary data - using a subset for MVP
     * In production, this would fetch from a CDN or local file
     */
    async loadDictionaryData() {
        // Common words with phoneme mappings for MVP
        const commonWords = {
            // Vowels and common sounds
            'A': ['AH0'],
            'THE': ['DH', 'AH0'],
            'AND': ['AH0', 'N', 'D'],
            'TO': ['T', 'UW0'],
            'OF': ['AH0', 'V'],
            'IN': ['IH0', 'N'],
            'IS': ['IH0', 'Z'],
            'YOU': ['Y', 'UW0'],
            'THAT': ['DH', 'AE0', 'T'],
            'IT': ['IH0', 'T'],
            'HE': ['HH', 'IY0'],
            'WAS': ['W', 'AH0', 'Z'],
            'FOR': ['F', 'AO0', 'R'],
            'ON': ['AO0', 'N'],
            'ARE': ['AA0', 'R'],
            'AS': ['AE0', 'Z'],
            'WITH': ['W', 'IH0', 'TH'],
            'HIS': ['HH', 'IH0', 'Z'],
            'THEY': ['DH', 'EY0'],
            'I': ['AY0'],
            'AT': ['AE0', 'T'],
            'BE': ['B', 'IY0'],
            'THIS': ['DH', 'IH0', 'S'],
            'HAVE': ['HH', 'AE0', 'V'],
            'FROM': ['F', 'R', 'AH0', 'M'],
            'OR': ['AO0', 'R'],
            'ONE': ['W', 'AH0', 'N'],
            'HAD': ['HH', 'AE0', 'D'],
            'BY': ['B', 'AY0'],
            'WORD': ['W', 'ER0', 'D'],
            'BUT': ['B', 'AH0', 'T'],
            'NOT': ['N', 'AA0', 'T'],
            'WHAT': ['W', 'AH0', 'T'],
            'ALL': ['AO0', 'L'],
            'WERE': ['W', 'ER0'],
            'WE': ['W', 'IY0'],
            'WHEN': ['W', 'EH0', 'N'],
            'YOUR': ['Y', 'AO0', 'R'],
            'CAN': ['K', 'AE0', 'N'],
            'SAID': ['S', 'EH0', 'D'],
            'THERE': ['DH', 'EH0', 'R'],
            'EACH': ['IY0', 'CH'],
            'WHICH': ['W', 'IH0', 'CH'],
            'SHE': ['SH', 'IY0'],
            'DO': ['D', 'UW0'],
            'HOW': ['HH', 'AW0'],
            'THEIR': ['DH', 'EH0', 'R'],
            'IF': ['IH0', 'F'],
            'WILL': ['W', 'IH0', 'L'],
            'UP': ['AH0', 'P'],
            'OTHER': ['AH0', 'DH', 'ER0'],
            'ABOUT': ['AH0', 'B', 'AW0', 'T'],
            'OUT': ['AW0', 'T'],
            'MANY': ['M', 'EH0', 'N', 'IY0'],
            'THEN': ['DH', 'EH0', 'N'],
            'THEM': ['DH', 'EH0', 'M'],
            'THESE': ['DH', 'IY0', 'Z'],
            'SO': ['S', 'OW0'],
            'SOME': ['S', 'AH0', 'M'],
            'HER': ['HH', 'ER0'],
            'WOULD': ['W', 'UH0', 'D'],
            'MAKE': ['M', 'EY0', 'K'],
            'LIKE': ['L', 'AY0', 'K'],
            'INTO': ['IH0', 'N', 'T', 'UW0'],
            'HIM': ['HH', 'IH0', 'M'],
            'TIME': ['T', 'AY0', 'M'],
            'TWO': ['T', 'UW0'],
            'MORE': ['M', 'AO0', 'R'],
            'GO': ['G', 'OW0'],
            'NO': ['N', 'OW0'],
            'WAY': ['W', 'EY0'],
            'MAY': ['M', 'EY0'],
            'SAY': ['S', 'EY0'],
            'COME': ['K', 'AH0', 'M'],
            'COULD': ['K', 'UH0', 'D'],
            'NOW': ['N', 'AW0'],
            'THAN': ['DH', 'AE0', 'N'],
            'FIRST': ['F', 'ER0', 'S', 'T'],
            'WATER': ['W', 'AO0', 'T', 'ER0'],
            'BEEN': ['B', 'IH0', 'N'],
            'CALL': ['K', 'AO0', 'L'],
            'WHO': ['HH', 'UW0'],
            'ITS': ['IH0', 'T', 'S'],
            'DID': ['D', 'IH0', 'D'],
            'GET': ['G', 'EH0', 'T'],
            'HAS': ['HH', 'AE0', 'Z'],
            'HIM': ['HH', 'IH0', 'M'],
            'OLD': ['OW0', 'L', 'D'],
            'SEE': ['S', 'IY0'],
            'TWO': ['T', 'UW0'],
            'WAY': ['W', 'EY0'],
            'WHO': ['HH', 'UW0'],
            'BOY': ['B', 'OY0'],
            'DID': ['D', 'IH0', 'D'],
            'ITS': ['IH0', 'T', 'S'],
            'LET': ['L', 'EH0', 'T'],
            'PUT': ['P', 'UH0', 'T'],
            'SAY': ['S', 'EY0'],
            'TOO': ['T', 'UW0'],
            'USE': ['Y', 'UW0', 'Z'],
            'HELLO': ['HH', 'AH0', 'L', 'OW0'],
            'WORLD': ['W', 'ER0', 'L', 'D'],
            'GOOD': ['G', 'UH0', 'D'],
            'GREAT': ['G', 'R', 'EY0', 'T'],
            'NICE': ['N', 'AY0', 'S'],
            'PLEASE': ['P', 'L', 'IY0', 'Z'],
            'THANK': ['TH', 'AE0', 'NG', 'K'],
            'THANKS': ['TH', 'AE0', 'NG', 'K', 'S'],
            'YES': ['Y', 'EH0', 'S'],
            'OKAY': ['OW0', 'K', 'EY0'],
            'RIGHT': ['R', 'AY0', 'T'],
            'WELL': ['W', 'EH0', 'L'],
            'KNOW': ['N', 'OW0'],
            'THINK': ['TH', 'IH0', 'NG', 'K'],
            'WANT': ['W', 'AA0', 'N', 'T'],
            'NEED': ['N', 'IY0', 'D'],
            'WORK': ['W', 'ER0', 'K'],
            'HELP': ['HH', 'EH0', 'L', 'P'],
            'LOVE': ['L', 'AH0', 'V'],
            'LIFE': ['L', 'AY0', 'F'],
            
            // Add missing words from your test
            'EVERYONE': ['EH1', 'V', 'R', 'IY0', 'W', 'AH0', 'N'],
            'KEN': ['K', 'EH1', 'N'],
            'JUST': ['JH', 'AH1', 'S', 'T'],
            'TEST': ['T', 'EH1', 'S', 'T'],
            'ANIMATION': ['AE2', 'N', 'AH0', 'M', 'EY1', 'SH', 'AH0', 'N'],
            'SHOW': ['SH', 'OW1'],
            'WORKS': ['W', 'ER1', 'K', 'S'],
            'PEOPLE': ['P', 'IY0', 'P', 'AH0', 'L'],
            'FAMILY': ['F', 'AE0', 'M', 'AH0', 'L', 'IY0'],
            'FRIEND': ['F', 'R', 'EH0', 'N', 'D'],
            'HOUSE': ['HH', 'AW0', 'S'],
            'HOME': ['HH', 'OW0', 'M'],
            'SCHOOL': ['S', 'K', 'UW0', 'L'],
            'MONEY': ['M', 'AH0', 'N', 'IY0'],
            'BUSINESS': ['B', 'IH0', 'Z', 'N', 'AH0', 'S'],
            'COMPUTER': ['K', 'AH0', 'M', 'P', 'Y', 'UW0', 'T', 'ER0'],
            'PHONE': ['F', 'OW0', 'N'],
            'MUSIC': ['M', 'Y', 'UW0', 'Z', 'IH0', 'K'],
            'MOVIE': ['M', 'UW0', 'V', 'IY0'],
            'BOOK': ['B', 'UH0', 'K'],
            'FOOD': ['F', 'UW0', 'D'],
            'WATER': ['W', 'AO0', 'T', 'ER0'],
            'COFFEE': ['K', 'AO0', 'F', 'IY0'],
            'HAPPY': ['HH', 'AE0', 'P', 'IY0'],
            'SORRY': ['S', 'AO0', 'R', 'IY0'],
            'EXCITED': ['IH0', 'K', 'S', 'AY0', 'T', 'AH0', 'D'],
            'AMAZING': ['AH0', 'M', 'EY0', 'Z', 'IH0', 'NG'],
            'BEAUTIFUL': ['B', 'Y', 'UW0', 'T', 'AH0', 'F', 'AH0', 'L']
        };

        // Load the common words into the dictionary
        for (const [word, phonemes] of Object.entries(commonWords)) {
            this.dictionary.set(word.toUpperCase(), phonemes);
        }

        console.log(`Loaded ${this.dictionary.size} words into CMU dictionary`);
    }

    /**
     * Get phonemes for a word
     * @param {string} word - Word to look up
     * @returns {Array|null} Array of phonemes or null if not found
     */
    getPhonemes(word) {
        const upperWord = word.toUpperCase().replace(/[^\w]/g, '');
        return this.dictionary.get(upperWord) || null;
    }

    /**
     * Check if word exists in dictionary
     * @param {string} word - Word to check
     * @returns {boolean} True if word exists
     */
    hasWord(word) {
        const upperWord = word.toUpperCase().replace(/[^\w]/g, '');
        return this.dictionary.has(upperWord);
    }

    /**
     * Get phonemes for multiple words
     * @param {Array} words - Array of words
     * @returns {Array} Array of phoneme arrays
     */
    getMultiplePhonemes(words) {
        return words.map(word => ({
            word,
            phonemes: this.getPhonemes(word),
            found: this.hasWord(word)
        }));
    }

    /**
     * Fallback phoneme generation for unknown words
     * Basic rule-based approach for words not in dictionary
     * @param {string} word - Unknown word
     * @returns {Array} Estimated phonemes
     */
    generateFallbackPhonemes(word) {
        const cleanWord = word.toLowerCase().replace(/[^\w]/g, '');
        const phonemes = [];

        // Very basic rule-based phoneme generation
        // This is a simplified approach - in production, use more sophisticated methods
        for (let i = 0; i < cleanWord.length; i++) {
            const char = cleanWord[i];
            const nextChar = cleanWord[i + 1];

            switch (char) {
                case 'a':
                    if (nextChar === 'i') {
                        phonemes.push('EY0');
                        i++; // Skip next character
                    } else if (nextChar === 'u') {
                        phonemes.push('AO0');
                        i++;
                    } else {
                        phonemes.push('AE0');
                    }
                    break;
                case 'e':
                    if (nextChar === 'e') {
                        phonemes.push('IY0');
                        i++;
                    } else {
                        phonemes.push('EH0');
                    }
                    break;
                case 'i':
                    if (nextChar === 'e') {
                        phonemes.push('IY0');
                        i++;
                    } else {
                        phonemes.push('IH0');
                    }
                    break;
                case 'o':
                    if (nextChar === 'o') {
                        phonemes.push('UW0');
                        i++;
                    } else if (nextChar === 'u') {
                        phonemes.push('AW0');
                        i++;
                    } else {
                        phonemes.push('AO0');
                    }
                    break;
                case 'u':
                    phonemes.push('AH0');
                    break;
                case 'y':
                    phonemes.push('AY0');
                    break;
                case 'b':
                    phonemes.push('B');
                    break;
                case 'c':
                    if (nextChar === 'h') {
                        phonemes.push('CH');
                        i++;
                    } else {
                        phonemes.push('K');
                    }
                    break;
                case 'd':
                    phonemes.push('D');
                    break;
                case 'f':
                    phonemes.push('F');
                    break;
                case 'g':
                    phonemes.push('G');
                    break;
                case 'h':
                    phonemes.push('HH');
                    break;
                case 'j':
                    phonemes.push('JH');
                    break;
                case 'k':
                    phonemes.push('K');
                    break;
                case 'l':
                    phonemes.push('L');
                    break;
                case 'm':
                    phonemes.push('M');
                    break;
                case 'n':
                    if (nextChar === 'g') {
                        phonemes.push('NG');
                        i++;
                    } else {
                        phonemes.push('N');
                    }
                    break;
                case 'p':
                    phonemes.push('P');
                    break;
                case 'r':
                    phonemes.push('R');
                    break;
                case 's':
                    if (nextChar === 'h') {
                        phonemes.push('SH');
                        i++;
                    } else {
                        phonemes.push('S');
                    }
                    break;
                case 't':
                    if (nextChar === 'h') {
                        phonemes.push('TH');
                        i++;
                    } else {
                        phonemes.push('T');
                    }
                    break;
                case 'v':
                    phonemes.push('V');
                    break;
                case 'w':
                    phonemes.push('W');
                    break;
                case 'x':
                    phonemes.push('K', 'S');
                    break;
                case 'z':
                    phonemes.push('Z');
                    break;
                default:
                    // Skip unknown characters
                    break;
            }
        }

        return phonemes.length > 0 ? phonemes : ['AH0']; // Default to schwa if no phonemes generated
    }

    /**
     * Get phonemes with fallback for unknown words
     * @param {string} word - Word to process
     * @returns {Array} Phonemes array
     */
    getPhonemesSafe(word) {
        const phonemes = this.getPhonemes(word);
        if (phonemes) {
            return phonemes;
        }

        // Use fallback for unknown words
        // Unknown word: fall back to rule-based phonemes
        return this.generateFallbackPhonemes(word);
    }

    /**
     * Get dictionary statistics
     * @returns {Object} Dictionary stats
     */
    getStats() {
        return {
            totalWords: this.dictionary.size,
            isLoaded: this.isLoaded,
            memoryUsage: this.dictionary.size * 50 // Rough estimate in bytes
        };
    }
}

if (typeof module !== "undefined" && module.exports) {
    module.exports = CMUDictionary;
}
