(ns cljdetector.storage.storage
  (:require [monger.core :as mg]
            [monger.collection :as mc]
            [monger.operators :refer :all]
            [monger.conversion :refer [from-db-object]]))

;; -------------------------------------------------------------------
;; Configuration
;; -------------------------------------------------------------------
(def DEFAULT-DBHOST "localhost")
(def dbname "cloneDetector")
(def partition-size 100)
(def hostname (or (System/getenv "DBHOST") DEFAULT-DBHOST))
(def collnames ["files"  "chunks" "candidates" "clones"])

;; -------------------------------------------------------------------
;; Helpers / Connection
;; -------------------------------------------------------------------
(defn get-dbconnection []
  "Return a monger connection object. Callers use this value with mg/get-db."
  (mg/connect {:host hostname}))

(defn- get-db [conn]
  (mg/get-db conn dbname))

;; -------------------------------------------------------------------
;; Statistics & housekeeping
;; -------------------------------------------------------------------
(defn print-statistics []
  (let [conn (mg/connect {:host hostname})
        db   (mg/get-db conn dbname)]
    (doseq [coll collnames]
      (println "db contains" (mc/count db coll) coll))))

(defn clear-db! []
  (let [conn (mg/connect {:host hostname})
        db   (mg/get-db conn dbname)]
    (doseq [coll collnames]
      (mc/drop db coll))))

(defn count-items [collname]
  (let [conn (mg/connect {:host hostname})
        db   (mg/get-db conn dbname)]
    (mc/count db collname)))

;; -------------------------------------------------------------------
;; File / chunk / clone storage
;; -------------------------------------------------------------------
(defn store-files! [files]
  (let [conn (mg/connect {:host hostname})
        db   (mg/get-db conn dbname)
        collname "files"
        file-parted (partition-all partition-size files)]
    (try
      (doseq [file-group file-parted]
        (mc/insert-batch db collname
                         (map (fn [f]
                                {:fileName (.getPath f) :contents (slurp f)})
                              file-group)))
      (catch Exception _ ;; swallow but do not crash
        []))))

(defn store-chunks! [chunks]
  (let [conn (mg/connect {:host hostname})
        db   (mg/get-db conn dbname)
        collname "chunks"
        chunk-parted (partition-all partition-size (flatten chunks))]
    (doseq [chunk-group chunk-parted]
      (mc/insert-batch db collname (map identity chunk-group)))))

(defn store-clones! [clones]
  (let [conn (mg/connect {:host hostname})
        db   (mg/get-db conn dbname)
        collname "clones"
        clones-parted (partition-all partition-size clones)]
    (doseq [clone-group clones-parted]
      (mc/insert-batch db collname (map identity clone-group)))))

(defn store-clone! [conn clone]
  (let [db (mg/get-db conn dbname)
        collname "clones"
        anonymous-clone (select-keys clone [:numberOfInstances :instances])]
    (mc/insert db collname anonymous-clone)))

;; -------------------------------------------------------------------
;; Candidate identification (aggregation)
;; -------------------------------------------------------------------
(defn identify-candidates! []
  (let [conn (mg/connect {:host hostname})
        db   (mg/get-db conn dbname)
        collname "chunks"]
    (mc/aggregate db collname
                  [{$group {:_id {:chunkHash "$chunkHash"}
                            :numberOfInstances {$count {}}
                            :instances {$push {:fileName "$fileName"
                                               :startLine "$startLine"
                                               :endLine "$endLine"}}}}
                   {$match {:numberOfInstances {$gt 1}}}
                   {"$out" "candidates"} ])))

;; -------------------------------------------------------------------
;; Candidate expansion helpers (used by expander)
;; -------------------------------------------------------------------
(defn get-one-candidate [conn]
  (let [db (get-db conn)]
    (from-db-object (mc/find-one db "candidates" {}) true)))

(defn get-overlapping-candidates [conn candidate]
  (let [db (get-db conn)
        clj-cand (from-db-object candidate true)]
    (mc/aggregate db "candidates"
                  [{$match {"instances.fileName" {$all (map #(:fileName %) (:instances clj-cand))}}}
                   {$addFields {:candidate candidate}}
                   {$unwind "$instances"}
                   {$project
                    {:matches
                     {$filter
                      {:input "$candidate.instances"
                       :cond {$and [{$eq ["$$this.fileName" "$instances.fileName"]}
                                    {$or [{$and [{$gt  ["$$this.startLine" "$instances.startLine"]}
                                                 {$lte ["$$this.startLine" "$instances.endLine"]}]}
                                          {$and [{$gt  ["$instances.startLine" "$$this.startLine"]}
                                                 {$lte ["$instances.startLine" "$$this.endLine"]}]}]}]}}}
                     :instances 1
                     :numberOfInstances 1
                     :candidate 1}}
                   {$match {$expr {$gt [{$size "$matches"} 0]}}}
                   {$group {:_id "$_id"
                            :candidate {$first "$candidate"}
                            :numberOfInstances {$max "$numberOfInstances"}
                            :instances {$push "$instances"}}}
                   {$match {$expr {$eq [{$size "$candidate.instances"} "$numberOfInstances"]}}}
                   {$project {:_id 1 :numberOfInstances 1 :instances 1}}])))

(defn remove-overlapping-candidates! [conn candidates]
  (let [db (get-db conn)]
    (mc/remove db "candidates" {:_id {$in (map #(:_id %) candidates)}})))

;; -------------------------------------------------------------------
;; Consolidation / formatting
;; -------------------------------------------------------------------
(defn consolidate-clones-and-source []
  (let [conn (mg/connect {:host hostname})
        db   (mg/get-db conn dbname)]
    (mc/aggregate db "clones"
                  [{$project {:_id 0 :instances "$instances" :sourcePosition {$first "$instances"}}}
                   {"$addFields" {:cloneLength {"$subtract" ["$sourcePosition.endLine" "$sourcePosition.startLine"]}}}
                   {$lookup
                    {:from "files"
                     :let {:sourceName "$sourcePosition.fileName"
                           :sourceStart {"$subtract" ["$sourcePosition.startLine" 1]}
                           :sourceLength "$cloneLength"}
                     :pipeline
                     [{$match {$expr {$eq ["$fileName" "$$sourceName"]}}}
                      {$project {:contents {"$split" ["$contents" "\n"]}}}
                      {$project {:contents {"$slice" ["$contents" "$$sourceStart" "$$sourceLength"]}}}
                      {$project
                       {:_id 0
                        :contents
                        {"$reduce"
                         {:input "$contents"
                          :initialValue ""
                          :in {"$concat"
                               ["$$value"
                                {"$cond" [{"$eq" ["$$value", ""]}, "", "\n"]}
                                "$$this"]}}}}}]
                     :as "sourceContents"}}
                   {$project {:_id 0 :instances 1 :contents "$sourceContents.contents"}}])))

;; -------------------------------------------------------------------
;; Status updates for monitoring
;; -------------------------------------------------------------------
(defn add-update!
  "Insert a status update document into the 'statusUpdates' collection.
   update-doc should contain at least :ts (epoch ms) and :message (string).
   Example: (add-update! {:ts 123456789 :iso \"...\" :message \"Reading files...\"})"
  [update-doc]
  (let [conn (mg/connect {:host hostname})
        db   (mg/get-db conn dbname)]
    ;; Use insert (not insert-batch) to keep updates immediate and simple
    (mc/insert db "statusUpdates" update-doc)
    true))

(defn ensure-status-index!
  "Create indexes used for monitoring. Safe to call multiple times."
  []
  (try
    (let [conn (mg/connect {:host hostname})
          db   (mg/get-db conn dbname)]
      ;; index timestamp for quick sorting / range queries
      (mc/ensure-index db "statusUpdates" {:ts 1})
      ;; index for quick lookup by message or other fields if needed later
      (mc/ensure-index db "statusUpdates" {:message 1})
      true)
    (catch Exception e
      (println "ensure-status-index! failed:" (.getMessage e))
      false)))

;; -------------------------------------------------------------------
;; Misc helpers used elsewhere
;; -------------------------------------------------------------------
(defn get-overall-counts []
  "Return a map with counts for main collections. Useful for MonitorTool."
  (let [conn (mg/connect {:host hostname})
        db   (mg/get-db conn dbname)]
    {:files (mc/count db "files")
     :chunks (mc/count db "chunks")
     :candidates (mc/count db "candidates")
     :clones (mc/count db "clones")}))

(defn get-latest-updates
  "Return latest N statusUpdates ordered by timestamp desc."
  ([n]
   (let [conn (mg/connect {:host hostname})
         db   (mg/get-db conn dbname)]
     (mc/find-maps db "statusUpdates" {} {:sort {:ts -1} :limit n}))))

;; -------------------------------------------------------------------
;; End of storage.clj
;; -------------------------------------------------------------------
