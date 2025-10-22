(ns cljdetector.core
  (:require [clojure.string :as string]
            [cljdetector.process.source-processor :as source-processor]
            [cljdetector.process.expander :as expander]
            [cljdetector.storage.storage :as storage]))

(def DEFAULT-CHUNKSIZE 5)
(def source-dir (or (System/getenv "SOURCEDIR") "/tmp"))
(def source-type #".*\.java")

(defn ts-println
  "Print timestamped message to stdout and also try to write to DB via storage/addUpdate!
   Use ns-resolve to lookup addUpdate! so we do not crash at compile time if not present.
   Errors while attempting DB write are caught and printed but do not stop execution."
  [& args]
  (let [iso  (.toString (java.time.LocalDateTime/now))
        ts   (System/currentTimeMillis)
        msg  (apply str (interpose " " args))]
    ;; Always print locally
    (println iso msg)
    ;; Try to store the update (non-fatal if it fails or method missing)
    (try
      (let [add-fn (ns-resolve 'cljdetector.storage.storage 'addUpdate!)]
        (when (and add-fn (fn? (deref add-fn)))
          ;; call resolved var (deref to get var->fn)
          ((deref add-fn) {:ts ts :iso iso :msg msg})))
      (catch Exception e
        (println "ts-println: failed to write status update to DB:" (.getMessage e))))
    ;; return nil for convenience
    nil))

(defn maybe-clear-db [args]
  (when (some #{"CLEAR"} (map string/upper-case args))
    (ts-println "Clearing database...")
    (storage/clear-db!)))

(defn maybe-read-files [args]
  (when-not (some #{"NOREAD"} (map string/upper-case args))
    (ts-println "Reading and Processing files...")
    (let [chunk-param (System/getenv "CHUNKSIZE")
          chunk-size (if chunk-param (Integer/parseInt chunk-param) DEFAULT-CHUNKSIZE)
          file-handles (source-processor/traverse-directory source-dir source-type)
          chunks (source-processor/chunkify chunk-size file-handles)]
      (ts-println "Storing files...")
      (storage/store-files! file-handles)
      (ts-println "Storing chunks of size" chunk-size "...")
      (storage/store-chunks! chunks))))

(defn maybe-detect-clones [args]
  (when-not (some #{"NOCLONEID"} (map string/upper-case args))
    (ts-println "Identifying Clone Candidates...")
    (storage/identify-candidates!)
    (ts-println "Found" (storage/count-items "candidates") "candidates")
    (ts-println "Expanding Candidates...")
    (expander/expand-clones)))

(defn pretty-print [clones]
  (doseq [clone clones]
    (println "====================\n" "Clone with" (count (:instances clone)) "instances:")
    (doseq [inst (:instances clone)]
      (println "  -" (:fileName inst) "startLine:" (:startLine inst) "endLine:" (:endLine inst)))
    (println "\nContents:\n----------\n" (:contents clone) "\n----------")))

(defn maybe-list-clones [args]
  (when (some #{"LIST"} (map string/upper-case args))
    (ts-println "Consolidating and listing clones...")
    (pretty-print (storage/consolidate-clones-and-source))))

(defn -main
  "Starting Point for All-At-Once Clone Detection
  Arguments:
   - Clear clears the database
   - NoRead do not read the files again
   - NoCloneID do not detect clones
   - List print a list of all clones"
  [& args]
  (maybe-clear-db args)
  (maybe-read-files args)
  (maybe-detect-clones args)
  (maybe-list-clones args)
  (ts-println "Summary")
  (storage/print-statistics))
