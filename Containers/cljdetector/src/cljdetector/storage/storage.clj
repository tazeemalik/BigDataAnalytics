(ns cljdetector.storage.storage
  (:require [monger.core :as mg]
            [monger.collection :as mc]
            [monger.operators :refer :all]
            [monger.conversion :refer [from-db-object]]))

(def DEFAULT-DBHOST "localhost")
(def dbname "cloneDetector")
(def partition-size 100)
(def hostname (or (System/getenv "DBHOST") DEFAULT-DBHOST))
(def collnames ["files"  "chunks" "candidates" "clones" "statusUpdates"])

(defn print-statistics []
  (let [conn (mg/connect {:host hostname})
        db (mg/get-db conn dbname)]
    (doseq [coll collnames]
      (println "db contains" (mc/count db coll) coll))))

(defn clear-db! []
  (let [conn (mg/connect {:host hostname})
        db (mg/get-db conn dbname)]
    (doseq [coll collnames]
      (mc/drop db coll))))

(defn count-items [collname]
  (let [conn (mg/connect {:host hostname})
        db (mg/get-db conn dbname)]
    (mc/count db collname)))

(defn store-files! [files]
  (let [conn (mg/connect {:host hostname})
        db (mg/get-db conn dbname)
        collname "files"
        file-parted (partition-all partition-size files)]
    (try (doseq [file-group file-parted]
           (mc/insert-batch db collname (map (fn [%] {:fileName (.getPath %) :contents (slurp %)}) file-group)))
         (catch Exception e []))))

(defn store-chunks! [chunks]
  (let [conn (mg/connect {:host hostname})
        db (mg/get-db conn dbname)
        collname "chunks"
        chunk-parted (partition-all partition-size (flatten chunks))]
    (doseq [chunk-group chunk-parted]
      (mc/insert-batch db collname (map identity chunk-group)))))

      ;; Add this function to store status updates (ts = epoch ms, iso = iso timestamp, msg = string)
(defn addUpdate! [update]
  (let [conn (mg/connect {:host hostname})
        db   (mg/get-db conn dbname)]
    ;; ensure statusUpdates collection exists and has an index on ts (ascending)
    (try
      (mc/ensure-index db "statusUpdates" (array-map :ts 1) {:background true})
      (catch Exception _))
    (mc/insert db "statusUpdates" update)))

;; Convenience: function to count status updates (optional)
(defn count-status-updates []
  (let [conn (mg/connect {:host hostname})
        db   (mg/get-db conn dbname)]
    (mc/count db "statusUpdates")))


(defn store-clones! [clones]
  (let [conn (mg/connect {:host hostname})
        db (mg/get-db conn dbname)
        collname "clones"
        clones-parted (partition-all partition-size clones)]
    (doseq [clone-group clones-parted]
      (mc/insert-batch db collname (map identity clone-group)))))

(defn identify-candidates! []
  (let [conn (mg/connect {:host hostname})
        db (mg/get-db conn dbname)
        collname "chunks"]
     (mc/aggregate db collname
                   [{$group {:_id {:chunkHash "$chunkHash"}
                             :numberOfInstances {$count {}}
                             :instances {$push {:fileName "$fileName"
                                                :startLine "$startLine"
                                                :endLine "$endLine"}}}}
                    {$match {:numberOfInstances {$gt 1}}}
                    {"$out" "candidates"} ])))

(defn consolidate-clones-and-source []
  (let [conn (mg/connect {:host hostname})
        db (mg/get-db conn dbname)
        collname "clones"]
    (mc/aggregate db collname
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
                                "$$this"]
                               }}}}}]
                     :as "sourceContents"}}
                   {$project {:_id 0 :instances 1 :contents "$sourceContents.contents"}}])))

(defn get-dbconnection []
  (mg/connect {:host hostname}))

(defn get-one-candidate [conn]
  (let [db (mg/get-db conn dbname)
        collname "candidates"]
    (from-db-object (mc/find-one db collname {}) true)))

(defn get-overlapping-candidates [conn candidate]
  (let [db (mg/get-db conn dbname)
        collname "candidates"
        clj-cand (from-db-object candidate true)]
    (mc/aggregate db collname
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
                     :candidate 1
                     }}
                   {$match {$expr {$gt [{$size "$matches"} 0]}}}
                   {$group {:_id "$_id"
                            :candidate {$first "$candidate"}
                            :numberOfInstances {$max "$numberOfInstances"}
                            :instances {$push "$instances"}}}
                   {$match {$expr {$eq [{$size "$candidate.instances"} "$numberOfInstances"]}}}
                   {$project {:_id 1 :numberOfInstances 1 :instances 1}}])))

(defn remove-overlapping-candidates! [conn candidates]
  (let [db (mg/get-db conn dbname)
        collname "candidates"]
      (mc/remove db collname {:_id {$in (map #(:_id %) candidates)}})))

(defn store-clone! [conn clone]
  (let [db (mg/get-db conn dbname)
        collname "clones"
        anonymous-clone (select-keys clone [:numberOfInstances :instances])]
    (mc/insert db collname anonymous-clone)))

;; ------------------------------------------------------------------
;; addUpdate! - store timestamped status messages in 'statusUpdates'
;; payload is expected to be a map like {:ts <ms> :iso <iso-string> :msg <string>}
;; ------------------------------------------------------------------
(defn addUpdate! [update-map]
  (let [conn (mg/connect {:host hostname})
        db (mg/get-db conn dbname)
        collname "statusUpdates"
        ;; make safe doc from given map
        doc (cond
              (map? update-map) update-map
              (string? update-map) {:ts (System/currentTimeMillis) :msg update-map}
              :else {:ts (System/currentTimeMillis) :msg (str update-map)})]
    (try
      (mc/insert db collname doc)
      (catch Exception e
        ;; swallow errors; callers should not fail because of logging issues
        (println "storage/addUpdate!: failed to insert status update:" (.getMessage e))))))
