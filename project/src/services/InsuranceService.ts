import { inject, injectable } from "tsyringe";
import { ITraderBase } from "../models/eft/common/tables/ITrader";

import { DialogueHelper } from "../helpers/DialogueHelper";
import { HandbookHelper } from "../helpers/HandbookHelper";
import { ItemHelper } from "../helpers/ItemHelper";
import { SecureContainerHelper } from "../helpers/SecureContainerHelper";
import { TraderHelper } from "../helpers/TraderHelper";
import { IPmcData } from "../models/eft/common/IPmcData";
import { Item } from "../models/eft/common/tables/IItem";
import { IInsuredItemsData } from "../models/eft/inRaid/IInsuredItemsData";
import { ISaveProgressRequestData } from "../models/eft/inRaid/ISaveProgressRequestData";
import { ConfigTypes } from "../models/enums/ConfigTypes";
import { MessageType } from "../models/enums/MessageType";
import { Traders } from "../models/enums/Traders";
import { IInsuranceConfig } from "../models/spt/config/IInsuranceConfig";
import { ILogger } from "../models/spt/utils/ILogger";
import { ConfigServer } from "../servers/ConfigServer";
import { DatabaseServer } from "../servers/DatabaseServer";
import { SaveServer } from "../servers/SaveServer";
import { JsonUtil } from "../utils/JsonUtil";
import { RandomUtil } from "../utils/RandomUtil";
import { TimeUtil } from "../utils/TimeUtil";
import { LocaleService } from "./LocaleService";
import { LocalisationService } from "./LocalisationService";
import { MailSendService } from "./MailSendService";

@injectable()
export class InsuranceService
{
    protected insured: Record<string, Record<string, Item[]>> = {};
    protected insuranceConfig: IInsuranceConfig;

    constructor(
        @inject("WinstonLogger") protected logger: ILogger,
        @inject("DatabaseServer") protected databaseServer: DatabaseServer,
        @inject("SecureContainerHelper") protected secureContainerHelper: SecureContainerHelper,
        @inject("RandomUtil") protected randomUtil: RandomUtil,
        @inject("ItemHelper") protected itemHelper: ItemHelper,
        @inject("JsonUtil") protected jsonUtil: JsonUtil,
        @inject("TimeUtil") protected timeUtil: TimeUtil,
        @inject("SaveServer") protected saveServer: SaveServer,
        @inject("TraderHelper") protected traderHelper: TraderHelper,
        @inject("DialogueHelper") protected dialogueHelper: DialogueHelper,
        @inject("HandbookHelper") protected handbookHelper: HandbookHelper,
        @inject("LocalisationService") protected localisationService: LocalisationService,
        @inject("LocaleService") protected localeService: LocaleService,
        @inject("MailSendService") protected mailSendService: MailSendService,
        @inject("ConfigServer") protected configServer: ConfigServer
    )
    {
        this.insuranceConfig = this.configServer.getConfig(ConfigTypes.INSURANCE);
    }

    /**
     * Does player have insurance array
     * @param sessionId Player id
     * @returns True if exists
     */
    public insuranceExists(sessionId: string): boolean
    {
        return this.insured[sessionId] !== undefined;
    }

    /**
     * Get all insured items by all traders for a profile
     * @param sessionId Profile id (session id)
     * @returns Item array
     */
    public getInsurance(sessionId: string): Record<string, Item[]>
    {
        return this.insured[sessionId];
    }

    /**
     * Get insured items by profile id + trader id
     * @param sessionId Profile id (session id)
     * @param traderId Trader items were insured with
     * @returns Item array
     */
    public getInsuranceItems(sessionId: string, traderId: string): Item[]
    {
        return this.insured[sessionId][traderId];
    }

    public resetInsurance(sessionId: string): void
    {
        this.insured[sessionId] = {};
    }

    /**
     * Sends stored insured items as message to player
     * @param pmcData profile to send insured items to
     * @param sessionID SessionId of current player
     * @param mapId Id of the map player died/exited that caused the insurance to be issued on
     */
    public sendInsuredItems(pmcData: IPmcData, sessionID: string, mapId: string): void
    {
        for (const traderId in this.getInsurance(sessionID))
        {
            const traderBase = this.traderHelper.getTrader(traderId, sessionID);
            const insuranceReturnTimestamp = this.getInsuranceReturnTimestamp(pmcData, traderBase);
            const dialogueTemplates = this.databaseServer.getTables().traders[traderId].dialogue;

            // Construct "i will go look for your stuff" message
            const messageContent = this.dialogueHelper.createMessageContext(this.randomUtil.getArrayValue(dialogueTemplates.insuranceStart), MessageType.NPC_TRADER, traderBase.insurance.max_storage_time);
            messageContent.text = ""; // Live insurance returns have an empty string for the text property
            messageContent.profileChangeEvents = [];
            messageContent.systemData = {
                date: this.timeUtil.getDateMailFormat(),
                time: this.timeUtil.getTimeMailFormat(),
                location: mapId
            };

            // MUST occur after systemData is hydrated
            // Store "i will go look for your stuff" message in player profile
            this.dialogueHelper.addDialogueMessage(traderId, messageContent, sessionID);

            // Remove 'hideout' slotid property on all insurance items
            this.removeLocationProperty(sessionID, traderId);

            // Reuse existing context for message sent to player with insurance return
            messageContent.templateId = this.randomUtil.getArrayValue(dialogueTemplates.insuranceFound);
            messageContent.type = MessageType.INSURANCE_RETURN;

            // Store insurance return details in profile + "hey i found your stuff, here you go!" message details to send player at a later date
            this.saveServer.getProfile(sessionID).insurance.push({
                scheduledTime: insuranceReturnTimestamp,
                traderId: traderId,
                messageContent: messageContent,
                items: this.getInsurance(sessionID)[traderId]
            });
        }

        this.resetInsurance(sessionID);
    }

    /**
     * Send a message to player informing them gear was lost
     * @param sessionId Session id
     * @param locationName name of map insurance was lost on
     */
    public sendLostInsuranceMessage(sessionId: string, locationName = ""): void
    {
        const dialogueTemplates = this.databaseServer.getTables().traders[Traders.PRAPOR].dialogue; // todo: get trader id instead of hard coded prapor
        const randomResponseId = locationName?.toLowerCase() === "laboratory"
            ? this.randomUtil.getArrayValue(dialogueTemplates["insuranceFailedLabs"])
            : this.randomUtil.getArrayValue(dialogueTemplates["insuranceFailed"]);

        this.mailSendService.sendLocalisedNpcMessageToPlayer(
            sessionId,
            Traders.PRAPOR,
            MessageType.NPC_TRADER,
            randomResponseId,
            [],
            null,
            {location: locationName});
    }

    /**
     * Check all root insured items and remove location property + set slotId to 'hideout'
     * @param sessionId Session id
     * @param traderId Trader id
     */
    protected removeLocationProperty(sessionId: string, traderId: string): void
    {
        const insuredItems = this.getInsurance(sessionId)[traderId];
        for (const insuredItem of this.getInsurance(sessionId)[traderId])
        {
            // Find insured items parent
            const insuredItemsParent = insuredItems.find(x => x._id === insuredItem.parentId);
            if (!insuredItemsParent)
            {
                // Remove location + set slotId of insured items parent
                insuredItem.slotId = "hideout";
                delete insuredItem.location;
            }
        }
    }

    /**
     * Get a timestamp of when insurance items should be sent to player based on trader used to insure
     * Apply insurance return bonus if found in profile
     * @param pmcData Player profile
     * @param trader Trader base used to insure items
     * @returns Timestamp to return items to player in seconds
     */
    protected getInsuranceReturnTimestamp(pmcData: IPmcData, trader: ITraderBase): number
    {
        // If override inconfig is non-zero, use that instead of trader values
        if (this.insuranceConfig.returnTimeOverrideSeconds > 0)
        {
            this.logger.debug(`Insurance override used: returning in ${this.insuranceConfig.returnTimeOverrideSeconds} seconds`);
            return this.timeUtil.getTimestamp() + this.insuranceConfig.returnTimeOverrideSeconds;
        }

        const insuranceReturnTimeBonus = pmcData.Bonuses.find(b => b.type === "InsuranceReturnTime");
        const insuranceReturnTimeBonusPercent = 1.0 - (insuranceReturnTimeBonus
            ? Math.abs(insuranceReturnTimeBonus.value)
            : 0) / 100;

        const traderMinReturnAsSeconds = trader.insurance.min_return_hour * TimeUtil.oneHourAsSeconds;
        const traderMaxReturnAsSeconds = trader.insurance.max_return_hour * TimeUtil.oneHourAsSeconds;
        const randomisedReturnTimeSeconds = this.randomUtil.getInt(traderMinReturnAsSeconds, traderMaxReturnAsSeconds);

        // Current time + randomised time calculated above
        return this.timeUtil.getTimestamp() + (randomisedReturnTimeSeconds * insuranceReturnTimeBonusPercent);
    }

    /**
     * Store lost gear post-raid inside profile, ready for later code to pick it up and mail it
     * @param pmcData player profile to store gear in
     * @param offraidData post-raid request object
     * @param preRaidGear gear player wore prior to raid
     * @param sessionID Session id
     * @param playerDied did the player die in raid
     */
    public storeLostGear(pmcData: IPmcData, offraidData: ISaveProgressRequestData, preRaidGear: Item[], sessionID: string, playerDied: boolean): void
    {
        const preRaidGearHash = this.createItemHashTable(preRaidGear);
        const offRaidGearHash = this.createItemHashTable(offraidData.profile.Inventory.items);

        const equipmentToSendToPlayer = [];
        for (const insuredItem of pmcData.InsuredItems)
        {
            // Skip insured items not on player when they started raid
            const preRaidItem = preRaidGearHash[insuredItem.itemId];
            if (!preRaidItem)
            {
                continue;
            }

            // Skip items we should never return
            if (this.insuranceConfig.blacklistedEquipment.includes(preRaidItem.slotId))
            {
                continue;
            }

            // Check if item missing in post-raid gear OR player died
            // Catches both events: player died with item on + player survied but dropped item in raid
            if (!offRaidGearHash[insuredItem.itemId] || playerDied)
            {
                equipmentToSendToPlayer.push({
                    pmcData: pmcData,
                    itemToReturnToPlayer: this.getInsuredItemDetails(pmcData, preRaidItem, offraidData.insurance?.find(x => x.id === insuredItem.itemId)),
                    traderId: insuredItem.tid,
                    sessionID: sessionID
                });
            }
        }

        // Process all insured items lost in-raid
        for (const gear of equipmentToSendToPlayer)
        {
            this.addGearToSend(gear);
        }
    }

    /**
     * Take preraid item and update properties to ensure its ready to be given to player in insurance return mail
     * @param pmcData Player profile
     * @param insuredItem Insured items properties
     * @param preRaidItem Insured item as it was pre-raid
     * @param insuredItemFromClient Item data when player left raid (durability values)
     * @returns Item object
     */
    protected getInsuredItemDetails(pmcData: IPmcData, preRaidItem: Item, insuredItemFromClient: IInsuredItemsData): Item
    {
        // Get baseline item to return, clone pre raid item
        const itemToReturn: Item = this.jsonUtil.clone(preRaidItem);

        // Add upd if it doesnt exist
        if (!itemToReturn.upd)
        {
            itemToReturn.upd = {};
        }

        // Check for slotid values that need to be updated and adjust
        this.updateSlotIdValue(pmcData.Inventory.equipment, itemToReturn);

        // Remove location property
        if (itemToReturn.slotId === "hideout" && "location" in itemToReturn)
        {
            delete itemToReturn.location;
        }

        // Remove found in raid status when upd exists + SpawnedInSession value exists
        if ("upd" in itemToReturn && "SpawnedInSession" in itemToReturn.upd)
        {
            itemToReturn.upd.SpawnedInSession = false;
        }

        // Client item has durability values, Ensure values persist into server data
        if (insuredItemFromClient?.durability)
        {
            // Item didnt have Repairable object pre-raid, add it
            if (!itemToReturn.upd.Repairable)
            {
                itemToReturn.upd.Repairable = {
                    Durability: insuredItemFromClient.durability,
                    MaxDurability: insuredItemFromClient.maxDurability
                };
            }
            else
            {
                itemToReturn.upd.Repairable.Durability = insuredItemFromClient.durability;
                itemToReturn.upd.Repairable.MaxDurability = insuredItemFromClient.maxDurability;
            }

        }

        // Client item has FaceShield values, Ensure values persist into server data
        if (insuredItemFromClient?.hits)
        {
            // Item didnt have faceshield object pre-raid, add it
            if (!itemToReturn.upd.FaceShield)
            {
                itemToReturn.upd.FaceShield = {
                    Hits: insuredItemFromClient.hits
                };
            }
            else
            {
                itemToReturn.upd.FaceShield.Hits = insuredItemFromClient.hits;
            }

        }

        return itemToReturn;
    }

    /**
     * Reset slotId property to "hideout" when necessary (used to be in )
     * @param pmcData Players pmcData.Inventory.equipment value
     * @param itemToReturn item we will send to player as insurance return
     */
    protected updateSlotIdValue(playerBaseInventoryEquipmentId: string, itemToReturn: Item): void
    {
        const pocketSlots = [
            "pocket1",
            "pocket2",
            "pocket3",
            "pocket4"
        ];

        // Some pockets can lose items with player death, some don't
        if (!("slotId" in itemToReturn) || pocketSlots.includes(itemToReturn.slotId)) 
        {
            itemToReturn.slotId = "hideout";
        }

        // Mark root-level items for later processing
        if (itemToReturn.parentId === playerBaseInventoryEquipmentId) 
        {
            itemToReturn.slotId = "hideout";
        }
    }

    /**
     * Create a hash table for an array of items, keyed by items _id
     * @param items Items to hash
     * @returns Hashtable
     */
    protected createItemHashTable(items: Item[]): Record<string, Item>
    {
        const hashTable: Record<string, Item> = {};
        for (const item of items)
        {
            hashTable[item._id] = item;
        }

        return hashTable;
    }

    /**
     * Add gear item to InsuredItems array in player profile
     * @param sessionID Session id
     * @param pmcData Player profile
     * @param itemToReturnToPlayer item to store
     * @param traderId Id of trader item was insured with
     */
    protected addGearToSend(gear: { sessionID: string; pmcData: IPmcData; itemToReturnToPlayer: Item; traderId: string}): void
    {
        const sessionId = gear.sessionID;
        const pmcData = gear.pmcData;
        const itemToReturnToPlayer = gear.itemToReturnToPlayer;
        const traderId = gear.traderId;

        // Ensure insurance array is init
        if (!this.insuranceExists(sessionId))
        {
            this.resetInsurance(sessionId);
        }

        // init trader insurance array
        if (!this.insuranceTraderArrayExists(sessionId, traderId))
        {
            this.resetInsuranceTraderArray(sessionId, traderId);
        }

        this.addInsuranceItemToArray(sessionId, traderId, itemToReturnToPlayer);

        // Remove item from insured items array as its been processed
        pmcData.InsuredItems = pmcData.InsuredItems.filter((item) =>
        {
            return item.itemId !== itemToReturnToPlayer._id;
        });
    }

    /**
     * Does insurance exist for a player and by trader
     * @param sessionId Player id (session id)
     * @param traderId Trader items insured with
     * @returns True if exists
     */
    protected insuranceTraderArrayExists(sessionId: string, traderId: string): boolean
    {
        return this.insured[sessionId][traderId] !== undefined;
    }

    /**
     * Empty out array holding insured items by sessionid + traderid
     * @param sessionId Player id (session id)
     * @param traderId Trader items insured with
     */
    public resetInsuranceTraderArray(sessionId: string, traderId: string): void
    {
        this.insured[sessionId][traderId] = [];
    }

    /**
     * Store insured item
     * @param sessionId Player id (session id)
     * @param traderId Trader item insured with
     * @param itemToAdd Insured item
     */
    public addInsuranceItemToArray(sessionId: string, traderId: string, itemToAdd: Item): void
    {
		
        this.insured[sessionId][traderId].push(itemToAdd);
    }

    /**
     * Get price of insurance * multiplier from config
     * @param pmcData Player profile
     * @param inventoryItem Item to be insured
     * @param traderId Trader item is insured with
     * @returns price in roubles
     */
    public getPremium(pmcData: IPmcData, inventoryItem: Item, traderId: string): number
    {
        let insuranceMultiplier = this.insuranceConfig.insuranceMultiplier[traderId];
        if (!insuranceMultiplier)
        {
            insuranceMultiplier = 0.3;
            this.logger.warning(this.localisationService.getText("insurance-missing_insurance_price_multiplier", traderId));
        }

        // Multiply item handbook price by multiplier in config to get the new insurance price
        let pricePremium = this.itemHelper.getStaticItemPrice(inventoryItem._tpl) * insuranceMultiplier;
        const coef = this.traderHelper.getLoyaltyLevel(traderId, pmcData).insurance_price_coef;

        if (coef > 0)
        {
            pricePremium *= (1 - this.traderHelper.getLoyaltyLevel(traderId, pmcData).insurance_price_coef / 100);
        }

        return Math.round(pricePremium);
    }
}