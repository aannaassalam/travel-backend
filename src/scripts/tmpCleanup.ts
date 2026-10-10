/** TEMPORARY: removes fixtures left by the verification runs. */
import 'dotenv/config'
import mongoose from 'mongoose'
import connectDb from '../config/db.config'
import { Hotel, RoomType } from '../model/hotelModel'
import { Listing } from '../model/listingModel'
import { MenuItem, Restaurant } from '../model/restaurantModel'
async function main() {
  await connectDb()
  const test = { slug: /^zz(test|ui)/ }
  // copies made by the UI run: named "(copie)" and created in the last few hours
  const recentCopy = { 'name.fr': /\(copie\)$/, createdAt: { $gte: new Date(Date.now() - 4 * 3600000) } }
  const hotels = (await Hotel.find({ $or: [test, recentCopy] }).select('_id')).map(h => h._id)
  const rests = (await Restaurant.find({ $or: [test, recentCopy] }).select('_id')).map(r => r._id)
  const r = {
    listings: (await Listing.deleteMany(test)).deletedCount,
    roomTypes: (await RoomType.deleteMany({ hotel: { $in: hotels } })).deletedCount,
    hotels: (await Hotel.deleteMany({ _id: { $in: hotels } })).deletedCount,
    menuItems: (await MenuItem.deleteMany({ restaurant: { $in: rests } })).deletedCount,
    restaurants: (await Restaurant.deleteMany({ _id: { $in: rests } })).deletedCount,
  }
  const left = {
    testListings: await Listing.countDocuments(test),
    copies: await Restaurant.countDocuments({ 'name.fr': /\(copie\)$/ }),
    statuses: Object.fromEntries((await Listing.aggregate([{ $group: { _id: '$status', n: { $sum: 1 } } }])).map((x: any) => [x._id, x.n])),
    hotelStatuses: Object.fromEntries((await Hotel.aggregate([{ $group: { _id: '$status', n: { $sum: 1 } } }])).map((x: any) => [x._id, x.n])),
    restaurantStatuses: Object.fromEntries((await Restaurant.aggregate([{ $group: { _id: '$status', n: { $sum: 1 } } }])).map((x: any) => [x._id, x.n])),
  }
  console.log(JSON.stringify({ removed: r, left }))
  await mongoose.disconnect(); process.exit(0)
}
main().catch(e => { console.error(e); process.exit(1) })
